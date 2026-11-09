import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  shopeeModelListPayloadSchema,
  shopeeModelSchema,
  type ShopeeModel,
} from '@delfrance/integrations-shopee';
import {
  INTEGRACAO_TIPO,
  TIPO_VARIACAO,
  resolverEntradaShopeeDoGrupo,
  type LinkVariacoesShopee,
} from '@delfrance/schemas';

import type { GrupoMemo } from './itemLido';
import { nomesDasOpcoesDoModelo } from './mapeamento';
import {
  fundirLinksVariacoesShopee,
  nomeDeTierShopee,
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
    variationGroupId: 0,
    // ⚠️ `indice` is the WIRE position, and a fixture with TWO tiers has to say
    // so: the plan is keyed by it, exactly like `model.tier_index`.
    opcoes: [{ nome: 'Azul', optionId: 0, indice: 0 }],
    indice: 0,
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
    expect(lista[0]?.opcoes[1]).toEqual({ nome: 'Verde', optionId: 5002, indice: 1 });
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

  it('lê cada nome de tier e de opção pela dobra COMPARTILHADA — as pontas, nunca a caixa nem o espaço de dentro', () => {
    const lista = tiersDoItem({
      tiers: [
        {
          name: ' Cor\u00a0',
          option_list: [{ option: ' Azul ' }, { option: 'azul' }, { option: 'Azul  Claro' }],
        },
      ] as never,
      padronizados: [],
    });
    expect(lista[0]?.nome).toBe('Cor');
    expect(lista[0]?.opcoes.map((o) => o.nome)).toEqual(['Azul', 'azul', 'Azul  Claro']);
  });
});

describe('nomeDeTierShopee — a ÚNICA dobra de nome de tier/opção (#1911 batch-A: o leitor E o publicador)', () => {
  it('nomeDeTierShopee — IGUAL: as pontas; DISTINTO: a caixa e o espaço de dentro', () => {
    // PAR: the ends go — ASCII space, tab, NBSP — so what the publisher sends
    // and what this reader reads back are one string.
    for (const nome of ['Azul', 'Azul ', ' Azul', '\tAzul\n', '\u00a0Azul\u00a0']) {
      expect(nomeDeTierShopee(nome), JSON.stringify(nome)).toBe('Azul');
    }
    // ⛔ NEAR-MISS: case and inner whitespace are KEPT — Shopee keeps both.
    expect(nomeDeTierShopee('azul')).not.toBe(nomeDeTierShopee('Azul'));
    expect(nomeDeTierShopee('AZUL')).not.toBe(nomeDeTierShopee('Azul'));
    expect(nomeDeTierShopee('Azul  Claro')).not.toBe(nomeDeTierShopee('Azul Claro'));
    expect(nomeDeTierShopee(' Azul  Claro ')).toBe('Azul  Claro');
    // Absent and non-string read as the blank name.
    for (const nada of [null, undefined, 42 as never, '', '   ']) {
      expect(nomeDeTierShopee(nada)).toBe('');
    }
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
        tier({ nome: 'Tamanho', indice: 1, opcoes: [{ nome: 'P', optionId: 0, indice: 0 }] }),
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
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul Celeste', optionId: 5001, indice: 0 }] })],
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
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Roxo', optionId: 0, indice: 0 }] })],
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
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul', optionId: 0, indice: 0 }] })],
      candidatos: grupoCom([{ id: 'v-azul', nome: 'Azul' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-azul']);
  });

  it('⛔ NEAR-MISS: `azul` minúsculo NÃO casa por nome', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul', optionId: 0, indice: 0 }] })],
      candidatos: grupoCom([{ id: 'v-azul', nome: 'azul' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-azul']);
  });

  it('rung 3a: a vogal de gênero casa `Vermelha` com o armazenado `Vermelho`', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Vermelha', optionId: 0, indice: 0 }] })],
      candidatos: grupoCom([{ id: 'v-vermelho', nome: 'Vermelho' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-vermelho']);
  });

  it('rung 3b: espaço⇄hífen casa `Azul Marinho` com `Azul-Marinho`', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul Marinho', optionId: 0, indice: 0 }] })],
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
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Vermelha Clara', optionId: 0, indice: 0 }] })],
      candidatos: grupoCom([{ id: 'v-vc', nome: 'Vermelha-Claro' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-vermelha-clara']);
  });

  it('⛔ NEAR-MISS: e na ordem INVERSA também não — hífen depois vogal', () => {
    // `Azul-Vermelha` → (hífen) `Azul Vermelha` → (vogal) `Azul Vermelho`.
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul-Vermelha', optionId: 0, indice: 0 }] })],
      candidatos: grupoCom([{ id: 'v-av', nome: 'Azul Vermelho' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-azul-vermelha']);
  });

  it('⛔ NEAR-MISS: `Vermelha Clara` ainda NÃO alcança `Vermelho-Claro` (duas palavras)', () => {
    // A troca de vogal mexe só no ÚLTIMO caractere, então nem a composição
    // chega aqui — o par é mantido como documentação do limite real do fold.
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Vermelha Clara', optionId: 0, indice: 0 }] })],
      candidatos: grupoCom([{ id: 'v-vc2', nome: 'Vermelho-Claro' }]),
    });
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-vermelha-clara']);
  });

  it('rung 4: cria com `codigo: null` e o `externalVariacaoLinks` da integração', () => {
    const plano = planejarTaxonomia({
      ...base,
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Roxo', optionId: 5009, indice: 0 }] })],
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
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul', optionId: 5001, indice: 0 }] })],
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
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul', optionId: 5001, indice: 0 }] })],
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
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Roxo', optionId: 0, indice: 0 }] })],
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
  const base = {
    integracaoId: INTEGRACAO,
    categoryId: CATEGORIA,
    nomeCategoria: 'Camisetas',
    nowMs: AGORA,
  };

  /** O `tier_variation` CRU do caso do símbolo — o que `model.tier_index` endereça. */
  const TIERS_CRUS_SIMBOLO = shopeeModelListPayloadSchema.parse({
    model: [],
    tier_variation: [{ name: 'Cor', option_list: [{ option: '★' }, { option: 'Azul' }] }],
  }).tier_variation!;

  it('⛔ uma opção DESCARTADA antes de outra não desloca as seguintes', () => {
    // ⚠️ `tiersDoItem` COMPACTA: uma opção sem nome e sem id some da lista. Mas
    // `model.tier_index` endereça o `option_list` CRU, então ler a lista
    // compactada com um índice cru amarraria cada modelo à opção do vizinho —
    // em silêncio, e só depois do buraco. A opção nula no índice 0 é legal:
    // `option` é `z.string().nullable().default(null)` no schema do pacote.
    const tiers = tiersDoItem({
      tiers: [
        { name: 'Cor', option_list: [{ option: null }, { option: 'Azul' }, { option: 'Verde' }] },
      ] as never,
      padronizados: [],
    });
    // A compactação REALMENTE aconteceu — sem esta âncora o teste passaria por engano.
    expect(tiers[0]?.opcoes.map((o) => o.nome)).toEqual(['Azul', 'Verde']);
    expect(tiers[0]?.opcoes.map((o) => o.indice)).toEqual([1, 2]);

    const plano = planejarTaxonomia({
      ...base,
      tiers,
      modelos: [modelo([1], 11), modelo([2], 12)],
      candidatos: memo(),
    });

    // Cada modelo cai na SUA opção, e o buraco do índice 0 é um `null`.
    expect(plano.grupos[0]?.varianteIds).toEqual([null, 'n-azul', 'n-verde']);
    expect(plano.combosPorModelo.get(11)?.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/n-cor/variacoes/n-azul',
    ]);
    expect(plano.combosPorModelo.get(12)?.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/n-cor/variacoes/n-verde',
    ]);
  });

  it('⛔ o mesmo buraco no braço do CASAMENTO — não só no da criação', () => {
    // ⚠️ A opção descartada some antes do degrau 1, e as duas que sobram CASAM
    // com variantes que já existem. É um caminho diferente dentro do mesmo laço,
    // e sem esta célula a posição só ficaria fixada no braço que CRIA.
    const tiers = tiersDoItem({
      tiers: [
        { name: 'Cor', option_list: [{ option: null }, { option: 'Azul' }, { option: 'Verde' }] },
      ] as never,
      padronizados: [],
    });

    const plano = planejarTaxonomia({
      ...base,
      tiers,
      modelos: [modelo([1], 11), modelo([2], 12)],
      candidatos: memo([
        {
          id: 'g-cor',
          raw: {
            nome: 'Cor',
            variacoes: [
              { id: 'v-azul', nome: 'Azul' },
              { id: 'v-verde', nome: 'Verde' },
            ],
          },
        },
      ]),
    });

    expect(plano.grupos[0]?.criar).toBe(false);
    expect(plano.grupos[0]?.varianteIds).toEqual([null, 'v-azul', 'v-verde']);
    expect(plano.combosPorModelo.get(11)?.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/g-cor/variacoes/v-azul',
    ]);
    expect(plano.combosPorModelo.get(12)?.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/g-cor/variacoes/v-verde',
    ]);
  });

  it('⛔ uma opção sem slug antes de outra: quem some é ELA, e a seguinte fica no lugar', () => {
    // O outro descarte, um degrau abaixo: a opção passa por `tiersDoItem` (tem
    // nome) mas o degrau 4 não consegue criá-la, porque `optionId` é 0 e o nome
    // não gera slug nenhum — o caso normal de uma cor escrita só com símbolo ou
    // emoji fora de Fashion. O modelo dela não amarra nada; o da opção seguinte
    // amarra a PRÓPRIA.
    const tiers = tiersDoItem({
      tiers: [{ name: 'Cor', option_list: [{ option: '★' }, { option: 'Azul' }] }] as never,
      padronizados: [],
    });
    expect(tiers[0]?.opcoes.map((o) => o.nome)).toEqual(['★', 'Azul']);

    const plano = planejarTaxonomia({
      ...base,
      tiers,
      modelos: [modelo([0], 11), modelo([1], 12)],
      candidatos: memo(),
    });

    expect(plano.grupos[0]?.varianteIds).toEqual([null, 'n-azul']);
    expect(plano.combosPorModelo.get(11)).toEqual({
      grupoDeVariacoesUid: null,
      variacoesUid: null,
    });
    expect(plano.combosPorModelo.get(12)?.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/n-cor/variacoes/n-azul',
    ]);
    // ⚠️ E a IDENTIDADE do filho e o NOME dele falam da mesma opção: o nome sai
    // de `nomesDasOpcoesDoModelo`, que lê o `tier_variation` CRU.
    expect(nomesDasOpcoesDoModelo(TIERS_CRUS_SIMBOLO, [1])).toEqual(['Azul']);
  });

  it('⛔ um TIER descartado antes de outro não desloca os grupos', () => {
    // A mesma coisa um nível acima: `grupos[i]` lido com o índice cru do tier
    // responderia o tier SEGUINTE para todo modelo.
    const tiers = tiersDoItem({
      tiers: [
        { name: '  ', option_list: [{ option: 'U' }] },
        { name: 'Cor', option_list: [{ option: 'Azul' }, { option: 'Verde' }] },
      ] as never,
      padronizados: [],
    });
    expect(tiers.map((t) => t.nome)).toEqual(['Cor']);
    expect(tiers.map((t) => t.indice)).toEqual([1]);

    const plano = planejarTaxonomia({
      ...base,
      tiers,
      modelos: [modelo([0, 1], 11)],
      candidatos: memo(),
    });

    expect(plano.combosPorModelo.get(11)?.variacoesUid).toEqual([
      'documents/grupoDeVariacoes/n-cor/variacoes/n-verde',
    ]);
    // ÂNCORA do wire: o nome cru do modelo para esse mesmo par é Verde.
    expect(
      nomesDasOpcoesDoModelo(
        shopeeModelListPayloadSchema.parse({
          model: [],
          tier_variation: [
            { name: '  ', option_list: [{ option: 'U' }] },
            { name: 'Cor', option_list: [{ option: 'Azul' }, { option: 'Verde' }] },
          ],
        }).tier_variation!,
        [0, 1],
      ),
    ).toEqual(['U', 'Verde']);
  });

  it('projeta cada modelo nos dois campos de wire do produto', () => {
    const plano = planejarTaxonomia({
      tiers: [
        tier({
          nome: 'Cor',
          opcoes: [
            { nome: 'Azul', optionId: 0, indice: 0 },
            { nome: 'Verde', optionId: 0, indice: 1 },
          ],
        }),
        tier({
          nome: 'Tamanho',
          indice: 1,
          opcoes: [
            { nome: 'P', optionId: 0, indice: 0 },
            { nome: 'M', optionId: 0, indice: 1 },
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
      tiers: [tier({ nome: 'Cor', opcoes: [{ nome: 'Azul', optionId: 0, indice: 0 }] })],
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

  it('⛔ NEAR-MISS: um `variation_group_list` NÃO-ZERO do operador não é apagado por um nosso 0', () => {
    const r = fundirLinksVariacoesShopee(
      [{ ...entrada({ variation_group_list: 841350766059029 }) }],
      entrada({ variation_group_list: 0 }),
    );
    expect((r.array[0] as LinkVariacoesShopee).variation_group_list).toBe(841350766059029);
    expect(r.mudou).toBe(false);
  });

  it('preenche o grupo ao lado de um `variation_id` armazenado IGUAL ao nosso', () => {
    const r = fundirLinksVariacoesShopee(
      [{ ...entrada({ variation_id: 101056, variation_group_list: 0 }) }],
      entrada({ variation_id: 101056, variation_group_list: 844758844060204 }),
    );
    const e = r.array[0] as LinkVariacoesShopee;
    expect([e.variation_id, e.variation_group_list]).toEqual([101056, 844758844060204]);
    expect(r.mudou).toBe(true);
  });

  it('preenche o PAR inteiro sobre uma entrada (0, 0) — id e grupo do mesmo anúncio', () => {
    const r = fundirLinksVariacoesShopee(
      [{ ...entrada({ variation_id: 0, variation_group_list: 0 }) }],
      entrada({ variation_id: 101056, variation_group_list: 844758844060204 }),
    );
    const e = r.array[0] as LinkVariacoesShopee;
    expect([e.variation_id, e.variation_group_list]).toEqual([101056, 844758844060204]);
    expect(r.mudou).toBe(true);
  });

  it('⛔ NEAR-MISS: um grupo 0 ao lado de OUTRO `variation_id` armazenado NÃO é preenchido — nada muda', () => {
    // O grupo é da variação 101056; a entrada guarda 999. O par (999, grupo de
    // 101056) não é de anúncio nenhum, e o publicador o mandaria.
    const r = fundirLinksVariacoesShopee(
      [{ ...entrada({ variation_id: 999, variation_group_list: 0 }) }],
      entrada({ variation_id: 101056, variation_group_list: 844758844060204 }),
    );
    const e = r.array[0] as LinkVariacoesShopee;
    expect([e.variation_id, e.variation_group_list]).toEqual([999, 0]);
    expect(r.mudou).toBe(false);
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

/* -------- 6b. o grupo de variação de DOIS níveis (#1911, BR 2026-11-04) -------- */

/*
 * `standardise_tier_variation[].variation_group_id` — lido do anúncio por
 * `tiersDoItem` e gravado por `planejarTaxonomia` no `variation_group_list` da
 * entrada. Antes, o leitor o ignorava e o planejador gravava `0` sempre: uma
 * escrita de tier posterior não mandava grupo para uma variação de dois níveis.
 */
describe('o grupo de variação (`variation_group_id`) — lido do anúncio, gravado na importação', () => {
  const GRUPO_TAMANHO_BR = 844758844060204;
  /** Um grupo NÃO-ZERO diferente, de outra região (INT) — a escolha de um operador legado. */
  const GRUPO_LEGADO_INT = 841350766059029;

  /**
   * O formato BR de DOIS tiers, inline. Os campos de TIER são os da captura
   * (`get_model_list.br-anuncio-variacoes.json`, `$.response.standardise_tier_variation`):
   * `[0]` Cor 101054 SEM a chave `variation_group_id` (o nível único); `[1]`
   * Tamanho 101056 com o grupo 844758844060204 (Tamanho (BR)). As listas de
   * opções estão cortadas a uma por tier — elas não decidem o grupo.
   */
  const CRU_BR = {
    model: [],
    tier_variation: [
      { name: 'Cor', option_list: [{ option: 'Cor inventada' }] },
      { name: 'Tamanho', option_list: [{ option: 'M' }] },
    ],
    standardise_tier_variation: [
      {
        variation_id: 101054,
        variation_name: 'Cor',
        variation_option_list: [{ variation_option_id: 0, variation_option_name: 'Cor inventada' }],
      },
      {
        variation_id: 101056,
        variation_name: 'Tamanho',
        variation_group_id: GRUPO_TAMANHO_BR,
        variation_option_list: [{ variation_option_name: 'M' }],
      },
    ],
  };
  // Pelo schema do PACOTE, como a importação lê: a chave ausente vira `null`.
  const ARVORE_BR = shopeeModelListPayloadSchema.parse(CRU_BR);
  const tiersBr = () =>
    tiersDoItem({
      tiers: ARVORE_BR.tier_variation ?? [],
      padronizados: ARVORE_BR.standardise_tier_variation ?? [],
    });

  describe('tiersDoItem', () => {
    it('⭐ carrega o grupo por ÍNDICE no formato BR — Cor (sem a chave) ⇒ 0, Tamanho ⇒ 844758844060204', () => {
      // ÂNCORA: a Cor do BR NÃO traz a chave — não é um `0` explícito.
      expect('variation_group_id' in CRU_BR.standardise_tier_variation[0]!).toBe(false);

      expect(tiersBr().map((t) => [t.nome, t.variationId, t.variationGroupId])).toEqual([
        ['Cor', 101054, 0],
        ['Tamanho', 101056, GRUPO_TAMANHO_BR],
      ]);
    });

    it('⛔ NEAR-MISS: comprimentos DIFERENTES ⇒ todo `variationGroupId` é 0, como o id', () => {
      // O mesmo `pareia` do id: parear um par desalinhado grudaria o grupo de um
      // tier no nome de outro.
      const lista = tiersDoItem({
        tiers: [
          { name: 'Cor', option_list: [{ option: 'Azul' }] },
          { name: 'Tamanho', option_list: [{ option: 'P' }] },
        ] as never,
        padronizados: [
          { variation_id: 101056, variation_group_id: GRUPO_TAMANHO_BR, variation_option_list: [] },
        ] as never,
      });
      expect(lista.map((t) => t.variationGroupId)).toEqual([0, 0]);
      expect(lista.map((t) => t.variationId)).toEqual([0, 0]);
    });

    it('⛔ NEAR-MISS: um tier CUSTOM (`variation_id` 0) que traz um grupo ⇒ 0 — grupo é de variação padrão', () => {
      const lista = tiersDoItem({
        tiers: [{ name: 'Estampa', option_list: [{ option: 'Listrada' }] }] as never,
        padronizados: [
          { variation_id: 0, variation_group_id: 7, variation_option_list: [] },
        ] as never,
      });
      expect(lista[0]?.variationId).toBe(0);
      expect(lista[0]?.variationGroupId).toBe(0);
    });

    it('⛔ NEAR-MISS: um grupo `null` numa variação padrão ⇒ 0, nunca uma ausência', () => {
      const lista = tiersDoItem({
        tiers: [{ name: 'Tamanho', option_list: [{ option: 'P' }] }] as never,
        padronizados: [
          { variation_id: 101056, variation_group_id: null, variation_option_list: [] },
        ] as never,
      });
      expect(lista[0]?.variationId).toBe(101056);
      expect(lista[0]).toHaveProperty('variationGroupId', 0);
    });

    it('⛔ NEAR-MISS: as listas de OPÇÕES com comprimentos diferentes NÃO zeram o grupo — só os ids de opção', () => {
      // `pareiaOpcoes` decide só os ids de OPÇÃO. O grupo segue o `pareia` do
      // TIER, como o `variationId`: um portão pelas opções zeraria o grupo de
      // dois níveis assim que a lista de opções do anúncio divergisse da padrão.
      const lista = tiersDoItem({
        tiers: [{ name: 'Tamanho', option_list: [{ option: 'P' }, { option: 'M' }] }] as never,
        padronizados: [
          {
            variation_id: 101056,
            variation_group_id: GRUPO_TAMANHO_BR,
            variation_option_list: [{ variation_option_id: 555, variation_option_name: 'P' }],
          },
        ] as never,
      });
      // ÂNCORA: as opções de fato NÃO parearam (1 contra 2) — os ids voltaram custom.
      expect(lista[0]?.opcoes.map((o) => o.optionId)).toEqual([0, 0]);
      // …e o grupo sobreviveu: segue o `pareia`, como o `variationId`, nunca o `pareiaOpcoes`.
      expect(lista.map((t) => [t.variationId, t.variationGroupId])).toEqual([
        [101056, GRUPO_TAMANHO_BR],
      ]);
    });

    it('⛔ um tier DESCARTADO antes do padrão não desloca o grupo — o par é pelo índice do WIRE', () => {
      // `tiersDoItem` COMPACTA: o grupo do tier `i` é o de `padronizados[i]`,
      // nunca o da posição compactada (que aqui seria o do tier descartado).
      const lista = tiersDoItem({
        tiers: [
          { name: '', option_list: [] },
          { name: 'Tamanho', option_list: [{ option: 'M' }] },
        ] as never,
        padronizados: [
          { variation_id: 0, variation_group_id: null, variation_option_list: [] },
          { variation_id: 101056, variation_group_id: GRUPO_TAMANHO_BR, variation_option_list: [] },
        ] as never,
      });
      expect(lista.map((t) => [t.nome, t.indice, t.variationGroupId])).toEqual([
        ['Tamanho', 1, GRUPO_TAMANHO_BR],
      ]);
    });
  });

  describe('planejarTaxonomia', () => {
    const base = {
      modelos: [] as ShopeeModel[],
      integracaoId: INTEGRACAO,
      categoryId: CATEGORIA,
      nomeCategoria: 'Camisetas',
      nowMs: AGORA,
    };

    const entradasDe = (links: unknown): LinkVariacoesShopee[] => links as LinkVariacoesShopee[];

    /** O tier Tamanho (BR) já lido, com uma opção custom `M`. */
    const tamanho = tier({
      nome: 'Tamanho',
      variationId: 101056,
      variationGroupId: GRUPO_TAMANHO_BR,
      opcoes: [{ nome: 'M', optionId: 0, indice: 0 }],
    });

    /**
     * O grupo do operador JÁ importado: a variante `M` com o carimbo desta
     * integração e a entrada (conta, categoria) com a opção já mapeada — tudo
     * igual ao que a importação diria, MENOS o grupo armazenado.
     */
    const grupoArmazenado = (variationGroupList: number) =>
      memo([
        {
          id: 'shopee-101056',
          raw: {
            nome: 'Tamanho',
            variacoes: [
              {
                id: 'v-m',
                nome: 'M',
                externalVariacaoLinks: [
                  {
                    tipo: INTEGRACAO_TIPO.shopee,
                    integracaoId: INTEGRACAO,
                    externalId: 'M',
                    externalName: 'M',
                    timestamp: AGORA,
                  },
                ],
              },
            ],
            variacoesIds: ['v-m'],
            linksVariacoesShopee: [
              entrada({
                variation_id: 101056,
                variation_group_list: variationGroupList,
                variationOptions: [
                  { shopee_option_id: 0, shopee_option_name: 'M', arakene_variation_id: ['v-m'] },
                ],
              }),
            ],
          },
        },
      ]);

    it('⭐ importação NOVA do formato BR de dois tiers: Tamanho grava 844758844060204, Cor grava 0', () => {
      const plano = planejarTaxonomia({ ...base, tiers: tiersBr(), candidatos: memo() });

      const porId = new Map(plano.grupos.map((g) => [g.grupoId, g]));
      const cor = porId.get('shopee-101054');
      const tam = porId.get('shopee-101056');
      expect(cor?.criar).toBe(true);
      expect(tam?.criar).toBe(true);
      expect(entradasDe(cor?.docNovo?.linksVariacoesShopee)).toEqual([
        expect.objectContaining({ variation_id: 101054, variation_group_list: 0 }),
      ]);
      expect(entradasDe(tam?.docNovo?.linksVariacoesShopee)).toEqual([
        expect.objectContaining({
          integracaoShopeeId: INTEGRACAO,
          category_id: CATEGORIA,
          variation_id: 101056,
          variation_group_list: GRUPO_TAMANHO_BR,
        }),
      ]);
    });

    it('reimportação sobre uma entrada armazenada com grupo 0 ⇒ preenchido, e é a ÚNICA mudança', () => {
      const plano = planejarTaxonomia({
        ...base,
        tiers: [tamanho],
        candidatos: grupoArmazenado(0),
      });
      const g = plano.grupos[0];
      expect(g?.criar).toBe(false);
      // `mudou: true` — o patch existe; e só a entrada mudou, as variantes não.
      expect(g?.patch).not.toBeNull();
      expect(entradasDe(g?.patch?.linksVariacoesShopee)).toEqual([
        expect.objectContaining({ variation_id: 101056, variation_group_list: GRUPO_TAMANHO_BR }),
      ]);
      expect(g?.varianteIds).toEqual(['v-m']);
    });

    it('⭐ ⛔ NEAR-MISS: um grupo NÃO-ZERO diferente armazenado — o legado (INT) OU o de uma importação anterior — é MANTIDO, nada é escrito', () => {
      // Um não-zero armazenado — o que o operador escolheu no formulário legado
      // (`variacoesCadastroViewShopee.dart`) OU o que uma importação anterior
      // gravou (o primeiro anúncio daquela folha) — nunca é sobrescrito pelo que
      // o anúncio diz hoje: só um `0` armazenado é preenchido. Um grupo por
      // (grupo, conta, categoria) é o modelo do vínculo; quem o escolhe é o
      // operador, no editor de vínculos (#1911 P14).
      const plano = planejarTaxonomia({
        ...base,
        tiers: [tamanho],
        candidatos: grupoArmazenado(GRUPO_LEGADO_INT),
      });
      expect(plano.grupos[0]?.criar).toBe(false);
      expect(plano.grupos[0]?.patch).toBeNull();
    });

    it('⭐ ⛔ NEAR-MISS: o anúncio SEM grupo (0) não apaga um grupo legado NÃO-ZERO armazenado — nada é escrito', () => {
      // O par do teste do INT no sentido oposto: o anúncio vivo diz 0 (nível
      // único, ou um tier que a Shopee não agrupa) e o armazenado é a escolha do
      // operador legado. Só um `0` armazenado é preenchido; um não-zero nunca é
      // trocado — nem por outro grupo, nem por zero.
      const plano = planejarTaxonomia({
        ...base,
        tiers: [{ ...tamanho, variationGroupId: 0 }],
        candidatos: grupoArmazenado(GRUPO_LEGADO_INT),
      });
      expect(plano.grupos[0]?.criar).toBe(false);
      expect(plano.grupos[0]?.patch).toBeNull();
    });

    it('reimportação byte-idêntica com o grupo já armazenado ⇒ `mudou: false`, nada é escrito', () => {
      const plano = planejarTaxonomia({
        ...base,
        tiers: [tamanho],
        candidatos: grupoArmazenado(GRUPO_TAMANHO_BR),
      });
      expect(plano.grupos[0]?.criar).toBe(false);
      expect(plano.grupos[0]?.patch).toBeNull();
    });

    it('⭐ ⛔ NEAR-MISS: um grupo armazenado 0 ao lado de OUTRO `variation_id` NÃO-ZERO não recebe o grupo do anúncio', () => {
      // O grupo pertence à variação que o anúncio reporta (101056). A entrada
      // armazenada aponta outra (999, a escolha do operador), num grupo casado
      // pelo NOME, e o publicador manda o PAR armazenado (`tiersPublicacao.ts`):
      // gravar o grupo de 101056 ali montaria (999, 844758844060204) — e, por
      // ser não-zero, a fusão nunca o corrigiria.
      const plano = planejarTaxonomia({
        ...base,
        tiers: [tamanho],
        candidatos: memo([
          {
            id: 'g-tam',
            raw: {
              nome: 'Tamanho',
              variacoes: [],
              variacoesIds: [],
              linksVariacoesShopee: [entrada({ variation_id: 999, variation_group_list: 0 })],
            },
          },
        ]),
      });
      const nossa = entradasDe(plano.grupos[0]?.patch?.linksVariacoesShopee).find(
        (e) => e.category_id === CATEGORIA,
      );
      expect(plano.grupos[0]?.grupoId).toBe('g-tam');
      expect([nossa?.variation_id, nossa?.variation_group_list]).toEqual([999, 0]);
    });

    it('⭐ ⛔ NEAR-MISS: a entrada armazenada 88 contra o tier vivo 77 mantém o 88 — a fusão só ANEXA as linhas vivas, por isso reimportar não tira a recusa do #2043', () => {
      const plano = planejarTaxonomia({
        ...base,
        tiers: [
          tier({
            nome: 'Cor',
            variationId: 77,
            opcoes: [
              { nome: 'Verde', optionId: 6, indice: 0 },
              { nome: 'Azul', optionId: 5, indice: 1 },
            ],
          }),
        ],
        candidatos: memo([
          {
            id: 'g-cor',
            raw: {
              nome: 'Cor',
              variacoes: [
                { id: 'v-azul', nome: 'Azul' },
                { id: 'v-verde', nome: 'Verde' },
              ],
              linksVariacoesShopee: [
                entrada({
                  variation_id: 88,
                  variationOptions: [
                    {
                      shopee_option_id: 9,
                      shopee_option_name: 'Azul',
                      arakene_variation_id: ['v-azul'],
                    },
                  ],
                }),
              ],
            },
          },
        ]),
      });
      expect(plano.grupos[0]?.patch).not.toBeNull();
      const nossa = entradasDe(plano.grupos[0]?.patch?.linksVariacoesShopee)[0];
      expect(nossa?.variation_id).toBe(88);
      expect(nossa?.variationOptions.map((o) => o.shopee_option_id)).toEqual([9, 6, 5]);
    });
  });
});

/* ---------------- 7. a chave de vínculo COMPARTILHADA (#1911) -------------- */

/*
 * A importação e a publicação respondem "qual elemento é A entrada do par
 * (conta, categoria folha)" pela MESMA função de `@delfrance/schemas`
 * (`ehEntradaShopeeDaChave` / `resolverEntradaShopeeDoGrupo`). Antes do #1911 a
 * importação comparava o id da conta byte a byte e a publicação dobrava o
 * último segmento: uma entrada em forma de caminho era o vínculo para uma e uma
 * estranha para a outra, e a fusão anexava um GÊMEO que a publicação nunca lia.
 * Cada par IGUAL abaixo tem o seu gêmeo DISTINTO.
 */
describe('a chave de vínculo compartilhada — fusão, variante e grupo', () => {
  const FORMA_CAMINHO = `documents/integracao/${INTEGRACAO}`;

  describe('fundirLinksVariacoesShopee', () => {
    const opcaoDoOperador = {
      shopee_option_id: 5001,
      shopee_option_name: 'Azul',
      arakene_variation_id: ['v-do-op'],
    };
    const nossaOpcao = {
      shopee_option_id: 5001,
      shopee_option_name: 'Azul',
      arakene_variation_id: ['v-nosso'],
    };

    it('IGUAL: uma entrada armazenada em forma de caminho é fundida, nunca gêmea', () => {
      const armazenado = [
        { ...entrada({ integracaoShopeeId: FORMA_CAMINHO, variationOptions: [opcaoDoOperador] }) },
      ];
      const r = fundirLinksVariacoesShopee(armazenado, entrada({ variationOptions: [nossaOpcao] }));
      expect(r.array).toHaveLength(1);
      expect(r.mudou).toBe(true);
      const fundida = r.array[0] as LinkVariacoesShopee;
      // O id armazenado é preservado VERBATIM — a dobra lê, nunca reescreve.
      expect(fundida.integracaoShopeeId).toBe(FORMA_CAMINHO);
      expect(fundida.variationOptions[0]?.arakene_variation_id).toEqual(['v-do-op', 'v-nosso']);
    });

    it('IGUAL: as outras formas de caminho do mesmo id também são a entrada', () => {
      for (const forma of ['integracao/int-1', 'int-1/', '/documents/integracao/int-1/']) {
        const r = fundirLinksVariacoesShopee(
          [{ ...entrada({ integracaoShopeeId: forma }) }],
          entrada(),
        );
        expect(r.array, forma).toHaveLength(1);
        expect(r.mudou, forma).toBe(false);
      }
    });

    it('⛔ NEAR-MISS: `int-12` armazenado NÃO é `int-1` — fica intacto e a nossa é anexada', () => {
      const alheia = {
        ...entrada({ integracaoShopeeId: 'int-12', variationOptions: [opcaoDoOperador] }),
      };
      const r = fundirLinksVariacoesShopee([alheia], entrada({ variationOptions: [nossaOpcao] }));
      expect(r.array).toHaveLength(2);
      expect(r.array[0]).toBe(alheia);
      expect((r.array[1] as LinkVariacoesShopee).integracaoShopeeId).toBe(INTEGRACAO);
    });

    it('⛔ NEAR-MISS: e no sentido inverso — `int-1` armazenado não é a entrada de `int-12`', () => {
      const doInt1 = { ...entrada() };
      const r = fundirLinksVariacoesShopee([doInt1], entrada({ integracaoShopeeId: 'int-12' }));
      expect(r.array).toHaveLength(2);
      expect(r.array[0]).toBe(doInt1);
    });

    it('⛔ NEAR-MISS: o caminho de OUTRA conta (`documents/integracao/int-12`) não é `int-1`', () => {
      const alheia = { ...entrada({ integracaoShopeeId: 'documents/integracao/int-12' }) };
      const r = fundirLinksVariacoesShopee([alheia], entrada());
      expect(r.array).toHaveLength(2);
      expect(r.array[0]).toBe(alheia);
    });

    it('⛔ NEAR-MISS: caixa e espaço continuam distinguindo a conta', () => {
      for (const forma of ['INT-1', ' int-1', 'int-1 ']) {
        const r = fundirLinksVariacoesShopee(
          [{ ...entrada({ integracaoShopeeId: forma }) }],
          entrada(),
        );
        expect(r.array, JSON.stringify(forma)).toHaveLength(2);
      }
    });

    it('um gêmeo de uma importação antiga é fundido JUNTO — os dois ficam em dia', () => {
      // [a entrada que a publicação lê (forma caminho, primeira), o gêmeo nu
      // que a importação anterior anexou]. Toda entrada legível do par é
      // fundida, como antes; nenhuma terceira é anexada.
      const armazenado = [
        { ...entrada({ integracaoShopeeId: FORMA_CAMINHO, variationOptions: [opcaoDoOperador] }) },
        { ...entrada({ variationOptions: [opcaoDoOperador] }) },
      ];
      const r = fundirLinksVariacoesShopee(armazenado, entrada({ variationOptions: [nossaOpcao] }));
      expect(r.array).toHaveLength(2);
      for (const e of r.array as LinkVariacoesShopee[]) {
        expect(e.variationOptions[0]?.arakene_variation_id).toEqual(['v-do-op', 'v-nosso']);
      }
    });

    it('⛔ um elemento ILEGÍVEL que nomeia o par fica VERBATIM e a nossa é anexada', () => {
      // `variation_group_list` é um escalar; uma lista é o vínculo do operador
      // gravado quebrado. A fusão nunca escreve DENTRO dele.
      const quebrado = { ...entrada(), variation_group_list: [1, 2] };
      const r = fundirLinksVariacoesShopee([quebrado], entrada({ variationOptions: [nossaOpcao] }));
      expect(r.array).toHaveLength(2);
      expect(r.array[0]).toBe(quebrado);
      expect(r.mudou).toBe(true);
    });
  });

  describe('a cascata de VARIANTE, rung 1 — a mesma entrada que a publicação lê', () => {
    const base = {
      modelos: [] as ShopeeModel[],
      integracaoId: INTEGRACAO,
      categoryId: CATEGORIA,
      nomeCategoria: 'Camisetas',
      nowMs: AGORA,
    };
    const opcao = { nome: 'Azul Celeste', optionId: 5001, indice: 0 };
    const mapeamento = (varianteId: string) => [
      {
        shopee_option_id: 5001,
        shopee_option_name: 'qualquer',
        arakene_variation_id: [varianteId],
      },
    ];
    const grupoCom = (links: unknown[]) =>
      memo([
        {
          id: 'g-cor',
          raw: {
            nome: 'Cor',
            variacoes: [
              { id: 'v-a', nome: 'Nome A' },
              { id: 'v-b', nome: 'Nome B' },
            ],
            linksVariacoesShopee: links,
          },
        },
      ]);

    it('IGUAL: o mapeamento de opção de uma entrada em forma de caminho vence', () => {
      const plano = planejarTaxonomia({
        ...base,
        tiers: [tier({ nome: 'Cor', opcoes: [opcao] })],
        candidatos: grupoCom([
          entrada({ integracaoShopeeId: FORMA_CAMINHO, variationOptions: mapeamento('v-a') }),
        ]),
      });
      expect(plano.grupos[0]?.varianteIds).toEqual(['v-a']);
    });

    it('⛔ NEAR-MISS: o mapeamento de `int-12` NÃO é lido — a opção cai para a criação', () => {
      const plano = planejarTaxonomia({
        ...base,
        tiers: [tier({ nome: 'Cor', opcoes: [opcao] })],
        candidatos: grupoCom([
          entrada({ integracaoShopeeId: 'int-12', variationOptions: mapeamento('v-a') }),
        ]),
      });
      expect(plano.grupos[0]?.varianteIds).toEqual(['shopee-5001']);
    });

    it('a primeira entrada legível vence — exatamente a `armazenada` do resolvedor', () => {
      const links = [
        entrada({ integracaoShopeeId: FORMA_CAMINHO, variationOptions: mapeamento('v-a') }),
        entrada({ variationOptions: mapeamento('v-b') }),
      ];
      const plano = planejarTaxonomia({
        ...base,
        tiers: [tier({ nome: 'Cor', opcoes: [opcao] })],
        candidatos: grupoCom(links),
      });
      const resolucao = resolverEntradaShopeeDoGrupo(links, INTEGRACAO, CATEGORIA);
      expect(resolucao.tipo).toBe('armazenada');
      const daPublicacao =
        resolucao.tipo === 'armazenada'
          ? resolucao.entrada.variationOptions[0]?.arakene_variation_id[0]
          : null;
      expect(daPublicacao).toBe('v-a');
      expect(plano.grupos[0]?.varianteIds).toEqual([daPublicacao]);
    });

    it('e na ordem inversa a entrada nua, agora primeira, é a lida', () => {
      const plano = planejarTaxonomia({
        ...base,
        tiers: [tier({ nome: 'Cor', opcoes: [opcao] })],
        candidatos: grupoCom([
          entrada({ variationOptions: mapeamento('v-b') }),
          entrada({ integracaoShopeeId: FORMA_CAMINHO, variationOptions: mapeamento('v-a') }),
        ]),
      });
      expect(plano.grupos[0]?.varianteIds).toEqual(['v-b']);
    });

    it('um elemento ilegível ANTES da entrada legível não a esconde', () => {
      const plano = planejarTaxonomia({
        ...base,
        tiers: [tier({ nome: 'Cor', opcoes: [opcao] })],
        candidatos: grupoCom([
          { ...entrada({ variationOptions: mapeamento('v-b') }), variation_group_list: [1, 2] },
          entrada({ integracaoShopeeId: FORMA_CAMINHO, variationOptions: mapeamento('v-a') }),
        ]),
      });
      expect(plano.grupos[0]?.varianteIds).toEqual(['v-a']);
    });

    it('⛔ uma entrada só ILEGÍVEL não tem mapeamento: a importação cria, não recusa — e guarda o elemento', () => {
      const quebrado = {
        ...entrada({ variationOptions: mapeamento('v-a') }),
        variation_group_list: [1, 2],
      };
      const plano = planejarTaxonomia({
        ...base,
        tiers: [tier({ nome: 'Cor', opcoes: [opcao] })],
        candidatos: grupoCom([quebrado]),
      });
      expect(plano.grupos[0]?.varianteIds).toEqual(['shopee-5001']);
      const links = (plano.grupos[0]?.patch?.linksVariacoesShopee ?? []) as unknown[];
      expect(links).toHaveLength(2);
      expect(links[0]).toBe(quebrado);
    });
  });

  describe('a cascata de GRUPO, rung 1(b) — a metade-conta é a mesma dobra', () => {
    const base = {
      modelos: [] as ShopeeModel[],
      categoryId: CATEGORIA,
      nomeCategoria: 'Camisetas',
      nowMs: AGORA,
    };
    const candidatosCom = (integracaoShopeeId: string) =>
      memo([
        {
          id: 'g-operador',
          raw: {
            nome: 'Cor do Operador',
            linksVariacoesShopee: [{ integracaoShopeeId, category_id: 999, variation_id: 100015 }],
          },
        },
      ]);
    const tierPadrao = tier({ nome: 'Qualquer Coisa', variationId: 100015 });

    it('IGUAL: um vínculo em forma de caminho casa o grupo do operador', () => {
      const plano = planejarTaxonomia({
        ...base,
        integracaoId: INTEGRACAO,
        tiers: [tierPadrao],
        candidatos: candidatosCom(FORMA_CAMINHO),
      });
      expect(plano.grupos[0]?.grupoId).toBe('g-operador');
      expect(plano.grupos[0]?.criar).toBe(false);
    });

    it('⛔ NEAR-MISS: `int-12` armazenado não casa `int-1` — e o inverso também não', () => {
      const a = planejarTaxonomia({
        ...base,
        integracaoId: INTEGRACAO,
        tiers: [tierPadrao],
        candidatos: candidatosCom('int-12'),
      });
      expect(a.grupos[0]?.grupoId).toBe('shopee-100015');
      expect(a.grupos[0]?.criar).toBe(true);

      const b = planejarTaxonomia({
        ...base,
        integracaoId: 'int-12',
        tiers: [tierPadrao],
        candidatos: candidatosCom(INTEGRACAO),
      });
      expect(b.grupos[0]?.grupoId).toBe('shopee-100015');
    });

    it('⛔ NEAR-MISS: caixa diferente (`INT-1`) não é a mesma conta', () => {
      const plano = planejarTaxonomia({
        ...base,
        integracaoId: INTEGRACAO,
        tiers: [tierPadrao],
        candidatos: candidatosCom('INT-1'),
      });
      expect(plano.grupos[0]?.grupoId).toBe('shopee-100015');
    });
  });

  it('#1369: o módulo não soletra a chave uma segunda vez', () => {
    // O comportamento está fixado pelos pares acima; isto só pega uma
    // RE-soletração local — a forma que fez as duas cópias divergirem.
    const fonte = readFileSync(
      fileURLToPath(new URL('./taxonomiaShopeeCore.ts', import.meta.url)),
      'utf8',
    );
    expect(fonte.length).toBeGreaterThan(1_000);
    expect(/\.integracaoShopeeId\s*[!=]==/.test(fonte)).toBe(false);
    expect(/\.category_id\s*[!=]==/.test(fonte)).toBe(false);
    expect(/split\(['"]\/['"]\)/.test(fonte)).toBe(false);
    expect(fonte.includes(['chave', 'DaEntrada'].join(''))).toBe(false);
  });
});

/* ------- #1911 P14a (R3) — rung 1 also reads a stored CUSTOM option row -------- */

describe('planejarTaxonomia — #1911 P14a (R3): o rung 1 da VARIANTE também lê a linha CUSTOM (id 0) armazenada, pelo nome dobrado, como a publicação', () => {
  // The publisher pairs a live custom option through the stored id-0 row whose
  // name equals it through `nomeDeTierShopee` (`tiersPublicacao.ts`). Before
  // R3 this rung read only NON-zero rows, so a variante renamed after its row
  // was stored lost the binding here: rung 2 compared the live name with the
  // VARIANTE's, so the next re-import created a twin `n-<slug>` (unioned into a
  // byte-identical row, or a new row beside a trailing-space one), and later ones
  // bound that twin at rung 2 and wrote nothing. Invented names only.
  const base = {
    modelos: [] as ShopeeModel[],
    integracaoId: INTEGRACAO,
    categoryId: CATEGORIA,
    nomeCategoria: 'Camisetas',
    nowMs: AGORA,
  };
  const viva = (nome: string, optionId = 0) =>
    tier({ nome: 'Cor', opcoes: [{ nome, optionId, indice: 0 }] });
  const linha = (
    shopee_option_name: string,
    arakene_variation_id = ['v-erp'],
    shopee_option_id = 0,
  ) => ({
    shopee_option_id,
    shopee_option_name,
    arakene_variation_id,
  });
  const DO_ERP = { id: 'v-erp', nome: 'Cor do ERP' };
  const candidatosCom = (
    variationOptions: ReturnType<typeof linha>[],
    variacoes: { id: string; nome: string }[] = [DO_ERP],
  ) =>
    memo([
      {
        id: 'g-cor',
        raw: { nome: 'Cor', variacoes, linksVariacoesShopee: [entrada({ variationOptions })] },
      },
    ]);
  const planejar = (opcao: TierShopee, candidatos: GrupoMemo['docs']) =>
    planejarTaxonomia({ ...base, tiers: [opcao], candidatos });

  it("⚠️ PAR: a viva {0, 'Cor inventada'} + a linha {0, 'Cor inventada', [v-erp]} + a variante 'Cor do ERP' ⇒ liga v-erp — nenhuma n-cor-inventada criada, e a linha não ganha gêmea", () => {
    const plano = planejar(viva('Cor inventada'), candidatosCom([linha('Cor inventada')]));
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-erp']);
    const patch = plano.grupos[0]?.patch ?? {};
    expect(((patch.variacoes ?? []) as { id: string }[]).map((v) => v.id)).toEqual(['v-erp']);
    const entradas = (patch.linksVariacoesShopee ?? []) as LinkVariacoesShopee[];
    expect(entradas.map((e) => e.variationOptions)).toEqual([[linha('Cor inventada')]]);
  });

  it("⛔ QUASE: a linha {0, 'cor inventada'} (a CAIXA) NÃO casa no rung 1 — a caixa fica, e a opção cai para a criação", () => {
    const plano = planejar(viva('Cor inventada'), candidatosCom([linha('cor inventada')]));
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-cor-inventada']);
  });

  it("⚠️ PAR: a linha {0, 'Cor inventada '} (espaço no FIM) casa — as pontas dobram pelo nomeDeTierShopee", () => {
    const plano = planejar(viva('Cor inventada'), candidatosCom([linha('Cor inventada ')]));
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-erp']);
  });

  it("⛔ QUASE: a linha {0, 'Cor  inventada'} (DOIS espaços DENTRO) não casa", () => {
    const plano = planejar(viva('Cor inventada'), candidatosCom([linha('Cor  inventada')]));
    expect(plano.grupos[0]?.varianteIds).toEqual(['n-cor-inventada']);
  });

  it('⛔ QUASE: um [0] pendurado (a variante não existe mais) cai para o rung 2 — e só o [0] conta', () => {
    // Rung 2 binds the variante whose name is EXACTLY the live one.
    const pendurado = planejar(
      viva('Cor inventada'),
      candidatosCom(
        [linha('Cor inventada', ['v-sumiu'])],
        [DO_ERP, { id: 'v-nome', nome: 'Cor inventada' }],
      ),
    );
    expect(pendurado.grupos[0]?.varianteIds).toEqual(['v-nome']);
    // A live [1] does not stand in for a dangling [0]: the legacy `.first`.
    const segundo = planejar(
      viva('Cor inventada'),
      candidatosCom([linha('Cor inventada', ['v-sumiu', 'v-erp'])]),
    );
    expect(segundo.grupos[0]?.varianteIds).toEqual(['n-cor-inventada']);
  });

  it('⛔ QUASE: uma linha NÃO-ZERO nunca casa pelo nome — nem a viva custom pela linha {5, …}, nem a viva {5, …} pela linha {0, …}', () => {
    const custom = planejar(
      viva('Cor inventada'),
      candidatosCom([linha('Cor inventada', ['v-erp'], 5)]),
    );
    expect(custom.grupos[0]?.varianteIds).toEqual(['n-cor-inventada']);
    const padrao = planejar(viva('Cor inventada', 5), candidatosCom([linha('Cor inventada')]));
    expect(padrao.grupos[0]?.varianteIds).toEqual(['shopee-5']);
  });

  it('⛔ QUASE: uma linha {0, …} com arakene_variation_id VAZIO não liga nada — cai para o rung 2, e sem variante homônima para a criação', () => {
    const peloNome = planejar(
      viva('Cor inventada'),
      candidatosCom(
        [linha('Cor inventada', [])],
        [DO_ERP, { id: 'v-nome', nome: 'Cor inventada' }],
      ),
    );
    expect(peloNome.grupos[0]?.varianteIds).toEqual(['v-nome']);
    const criada = planejar(viva('Cor inventada'), candidatosCom([linha('Cor inventada', [])]));
    expect(criada.grupos[0]?.varianteIds).toEqual(['n-cor-inventada']);
  });

  it("⛔ QUASE: uma opção PADRÃO viva casa pelo ID, nunca pelo nome — a linha {6, 'Cor inventada'} não rouba a viva {5, 'Cor inventada'} da linha {5, 'Nome antigo inventado'}", () => {
    const plano = planejar(
      viva('Cor inventada', 5),
      candidatosCom(
        [linha('Cor inventada', ['v-outra'], 6), linha('Nome antigo inventado', ['v-erp'], 5)],
        [DO_ERP, { id: 'v-outra', nome: 'Outra do ERP' }],
      ),
    );
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-erp']);
  });

  it('⚠️ PAR: duas linhas {0, …} que dobram para o mesmo nome — vale a PRIMEIRA, a mesma que a publicação lê', () => {
    const plano = planejar(
      viva('Cor inventada'),
      candidatosCom(
        [linha('Cor inventada ', ['v-erp']), linha('Cor inventada', ['v-outra'])],
        [DO_ERP, { id: 'v-outra', nome: 'Outra do ERP' }],
      ),
    );
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-erp']);
  });

  it("⚠️ PAR: a LINHA vence a variante homônima — a viva {0, 'Cor inventada'} liga v-erp, nunca a outra variante de mesmo nome (como a publicação)", () => {
    const plano = planejar(
      viva('Cor inventada'),
      candidatosCom([linha('Cor inventada')], [{ id: 'v-xara', nome: 'Cor inventada' }, DO_ERP]),
    );
    expect(plano.grupos[0]?.varianteIds).toEqual(['v-erp']);
  });

  it.each([
    [
      'outra conta (int-12)',
      [entrada({ integracaoShopeeId: 'int-12', variationOptions: [linha('Cor inventada')] })],
    ],
    [
      'outra categoria',
      [entrada({ category_id: 999999, variationOptions: [linha('Cor inventada')] })],
    ],
    [
      'um elemento ilegível da mesma chave',
      [
        {
          ...entrada({ variationOptions: [linha('Cor inventada')] }),
          variation_group_list: [1, 2],
        },
      ],
    ],
    [
      'uma gêmea atrás da primeira entrada da chave',
      [entrada(), entrada({ variationOptions: [linha('Cor inventada')] })],
    ],
  ])(
    "⛔ QUASE: a linha {0, 'Cor inventada'} em %s NÃO é lida — o nome só vale dentro da entrada resolvida",
    (_caso, links) => {
      const plano = planejar(
        viva('Cor inventada'),
        memo([
          { id: 'g-cor', raw: { nome: 'Cor', variacoes: [DO_ERP], linksVariacoesShopee: links } },
        ]),
      );
      expect(plano.grupos[0]?.varianteIds).toEqual(['n-cor-inventada']);
    },
  );

  it('⚠️ import depois do rename: padrão mantém o texto da linha; personalizada cunha n- e anexa, e a linha antiga fica', () => {
    const linhasDe = (plano: ReturnType<typeof planejar>) =>
      ((plano.grupos[0]?.patch?.linksVariacoesShopee ?? []) as LinkVariacoesShopee[]).flatMap((e) =>
        e.variationOptions.map((o) => [o.shopee_option_name, o.arakene_variation_id]),
      );

    const padrao = planejar(
      tier({
        nome: 'Cor',
        variationId: 77,
        opcoes: [{ nome: 'Nome novo inventado', optionId: 5, indice: 0 }],
      }),
      memo([
        {
          id: 'g-cor',
          raw: {
            nome: 'Cor',
            variacoes: [DO_ERP],
            linksVariacoesShopee: [
              entrada({
                variation_id: 77,
                variationOptions: [linha('Nome antigo inventado', ['v-erp'], 5)],
              }),
            ],
          },
        },
      ]),
    );
    expect(padrao.grupos[0]?.varianteIds).toEqual(['v-erp']);
    expect(linhasDe(padrao)).toEqual([['Nome antigo inventado', ['v-erp']]]);

    const personalizada = planejar(
      viva('Nome novo inventado'),
      candidatosCom([linha('Nome antigo inventado')]),
    );
    expect(personalizada.grupos[0]?.varianteIds).toEqual(['n-nome-novo-inventado']);
    expect(linhasDe(personalizada)).toEqual([
      ['Nome antigo inventado', ['v-erp']],
      ['Nome novo inventado', ['n-nome-novo-inventado']],
    ]);
  });
});

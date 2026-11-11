import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SHOPEE_MODEL_MAX_PER_ITEM,
  SHOPEE_TIER_MAX_OPTIONS,
  shopeeModelSchema,
  shopeeStandardiseTierVariationSchema,
  shopeeTierVariationSchema,
  type ShopeeModel,
} from '@delfrance/integrations-shopee';
import { TIPO_VARIACAO, varianteFakePath, type Foto } from '@delfrance/schemas';

import { planejarTaxonomia } from '../produtos/taxonomiaShopeeCore';

import { MOTIVO_PUBLICACAO_BLOQUEADA } from './errosPublicacao';

import {
  fotoDaOpcaoDeTier,
  mesmoModelo,
  montarTiers,
  ordenarTiers,
  reconciliarModelos,
  requisicaoDeModelo,
  tiersVivosDe,
  type ArgsMontarTiers,
  type ArvoreVivaDoItem,
  type FilhoParaPublicar,
  type GrupoParaTier,
  type ModeloArmazenado,
  type VarianteDoTier,
} from './tiersPublicacao';

/* ---------------------------------- fixtures ------------------------------ */

const INTEGRACAO = 'int-1';
const CATEGORIA = 100001;
const MODEL_ID = 2000458802;

function variante(varianteId: string, nome: string, ordem = 1): VarianteDoTier {
  return { varianteId, nome, ordem };
}

interface OpcaoDeEntrada {
  readonly shopee_option_id: number;
  readonly shopee_option_name: string;
  readonly arakene_variation_id: readonly string[];
}

function entrada(parcial: {
  readonly variation_id?: number;
  readonly variation_group_list?: number;
  readonly integracaoShopeeId?: string;
  readonly category_id?: number;
  readonly variationOptions?: readonly OpcaoDeEntrada[] | unknown;
}): unknown {
  return {
    name: 'Cor',
    category_id: parcial.category_id ?? CATEGORIA,
    variation_id: parcial.variation_id ?? 0,
    variation_group_list: parcial.variation_group_list ?? 0,
    integracaoShopeeId: parcial.integracaoShopeeId ?? INTEGRACAO,
    variationOptions: parcial.variationOptions ?? [],
  };
}

function grupo(parcial: Partial<GrupoParaTier> & { readonly grupoId: string }): GrupoParaTier {
  return {
    nome: 'Cor',
    ordem: 1,
    permiteFotos: false,
    variacoes: [],
    linksVariacoesShopee: [entrada({})],
    ...parcial,
  };
}

function filho(
  parcial: Partial<FilhoParaPublicar> & { readonly produtoId: string },
): FilhoParaPublicar {
  return {
    sku: null,
    gtin: null,
    ordem: 1,
    variacoesUid: [],
    preco: 10,
    estoque: 5,
    fotos: [],
    linkModelId: null,
    linkDocId: null,
    tierIndexArmazenado: null,
    ...parcial,
  };
}

function foto(variantePath: string | null): Foto {
  return {
    arquivoOuterRef: 'arquivos/a1',
    arquivo200pxOuterRef: null,
    arquivo400pxOuterRef: null,
    arquivoJpegOuterRef: null,
    grupoDeVariacoesOuterRef: null,
    variantePath,
  };
}

function modeloVivo(parcial: {
  readonly model_id: number;
  readonly tier_index: readonly number[];
  readonly model_sku?: string | null;
  readonly gtin_code?: string | null;
}): ShopeeModel {
  return shopeeModelSchema.parse(parcial);
}

/** A live tree of ONE custom tier with the named options, in order. */
function arvore(nomes: readonly string[], modelos: readonly ShopeeModel[]): ArvoreVivaDoItem {
  return {
    tier_variation: [
      shopeeTierVariationSchema.parse({
        name: 'Cor',
        option_list: nomes.map((option) => ({ option })),
      }),
    ],
    standardise_tier_variation: null,
    model: modelos,
  };
}

function args(parcial: Partial<ArgsMontarTiers>): ArgsMontarTiers {
  return {
    integracaoId: INTEGRACAO,
    categoryId: CATEGORIA,
    grupos: [],
    filhos: [],
    bandaDeEstoque: null,
    bandaNomeDoTier: null,
    bandaNomeDaOpcao: null,
    ...parcial,
  };
}

function motivos(problemas: readonly { readonly motivo: string }[]): readonly string[] {
  return problemas.map((p) => p.motivo);
}

/* -------------------------------------------------------------------------- */
/*  (1) the tier ORDER                                                        */
/* -------------------------------------------------------------------------- */

describe('ordenarTiers — a ordem é derivada UMA vez e depois lida do anúncio vivo', () => {
  it('⚠️ PAR: põe o grupo com permiteFotos em tier 1, mesmo com ordem maior', () => {
    const comFoto = grupo({ grupoId: 'g-cor', nome: 'Cor', ordem: 9, permiteFotos: true });
    const semFoto = grupo({ grupoId: 'g-tam', nome: 'Tamanho', ordem: 1 });
    expect(ordenarTiers([semFoto, comFoto]).map((g) => g.grupoId)).toEqual(['g-cor', 'g-tam']);
  });

  it('⚠️ QUASE: ordem 2 e 10 põe 2 antes de 10 — nunca o sort de string do legado', () => {
    const dois = grupo({ grupoId: 'g-dois', nome: 'Dois', ordem: 2 });
    const dez = grupo({ grupoId: 'g-dez', nome: 'Dez', ordem: 10 });
    expect(ordenarTiers([dez, dois]).map((g) => g.grupoId)).toEqual(['g-dois', 'g-dez']);
  });

  it('renomear um grupo NÃO reordena os tiers', () => {
    const a = grupo({ grupoId: 'g-a', nome: 'Aaa', ordem: 1 });
    const b = grupo({ grupoId: 'g-b', nome: 'Bbb', ordem: 2 });
    const antes = ordenarTiers([a, b]).map((g) => g.grupoId);
    const depois = ordenarTiers([{ ...a, nome: 'Zzz' }, b]).map((g) => g.grupoId);
    expect(depois).toEqual(antes);
  });

  it('no republish a ordem vem da árvore VIVA, não de grupo.ordem', () => {
    const cor = grupo({ grupoId: 'g-cor', nome: 'Cor', ordem: 99 });
    const tam = grupo({ grupoId: 'g-tam', nome: 'Tamanho', ordem: 1 });
    // A ordem de criação seria [g-tam, g-cor]; o anúncio vivo diz o contrário.
    const viva = {
      tiers: [
        { nome: 'Cor', variationId: 0, variationGroupId: 0, opcoes: [], indice: 0 },
        { nome: 'Tamanho', variationId: 0, variationGroupId: 0, opcoes: [], indice: 1 },
      ],
      integracaoId: INTEGRACAO,
      categoryId: CATEGORIA,
    };
    expect(ordenarTiers([tam, cor], viva).map((g) => g.grupoId)).toEqual(['g-cor', 'g-tam']);
    expect(ordenarTiers([tam, cor]).map((g) => g.grupoId)).toEqual(['g-tam', 'g-cor']);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) per-tier authoring                                                    */
/* -------------------------------------------------------------------------- */

describe('montarTiers — a autoria por tier', () => {
  const azul = variante('v-azul', 'Azul');
  const verde = variante('v-verde', 'Verde');

  function comDuasOpcoes(parcialEntrada: Parameters<typeof entrada>[0]): GrupoParaTier {
    return grupo({
      grupoId: 'g-cor',
      nome: 'Cor',
      variacoes: [azul, verde],
      linksVariacoesShopee: [entrada(parcialEntrada)],
    });
  }

  const doisFilhos: readonly FilhoParaPublicar[] = [
    filho({ produtoId: 'p-1', variacoesUid: [varianteFakePath('g-cor', 'v-azul')] }),
    filho({ produtoId: 'p-2', variacoesUid: [varianteFakePath('g-cor', 'v-verde')] }),
  ];

  it('variation_name só é enviado quando variation_id é 0 (announcement 873)', () => {
    const custom = montarTiers(
      args({ grupos: [comDuasOpcoes({ variation_id: 0 })], filhos: doisFilhos }),
    );
    expect(custom.tiers[0]!.variation_name).toBe('Cor');

    const padrao = montarTiers(
      args({
        grupos: [
          comDuasOpcoes({
            variation_id: 77,
            variationOptions: [
              { shopee_option_id: 5, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
              {
                shopee_option_id: 6,
                shopee_option_name: 'Verde',
                arakene_variation_id: ['v-verde'],
              },
            ],
          }),
        ],
        filhos: doisFilhos,
      }),
    );
    expect(padrao.tiers[0]!.variation_name).toBeNull();
    expect(padrao.tiers[0]!.variation_id).toBe(77);
  });

  it('variation_group_list é ESCALAR — um array armazenado é recusado, não tolerado', () => {
    const comArray = grupo({
      grupoId: 'g-cor',
      variacoes: [azul],
      linksVariacoesShopee: [{ ...(entrada({}) as object), variation_group_list: [1, 2] }],
    });
    const r = montarTiers(args({ grupos: [comArray], filhos: [doisFilhos[0]!] }));
    expect(motivos(r.problemas)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo);
    expect(r.tiers).toHaveLength(0);

    const escalar = montarTiers(
      args({ grupos: [comDuasOpcoes({ variation_group_list: 42 })], filhos: doisFilhos }),
    );
    expect(escalar.tiers[0]!.variation_group_id).toBe(42);
    expect(escalar.problemas).toEqual([]);
  });

  it('opção sem vínculo em um tier PADRÃO vira variacao-sem-vinculo', () => {
    const r = montarTiers(
      args({
        grupos: [
          comDuasOpcoes({
            variation_id: 77,
            variationOptions: [
              { shopee_option_id: 5, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
            ],
          }),
        ],
        filhos: doisFilhos,
      }),
    );
    expect(motivos(r.problemas)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo);
  });

  it('opção sem vínculo em um tier CUSTOM vira option_id 0 com o nome da variante', () => {
    const r = montarTiers(
      args({ grupos: [comDuasOpcoes({ variation_id: 0 })], filhos: doisFilhos }),
    );
    expect(r.problemas).toEqual([]);
    expect(r.tiers[0]!.opcoes.map((o) => [o.variation_option_id, o.variation_option_name])).toEqual(
      [
        [0, 'Azul'],
        [0, 'Verde'],
      ],
    );
  });

  it('duas variantes no mesmo shopee_option_id viram combinacao-duplicada', () => {
    const r = montarTiers(
      args({
        grupos: [
          comDuasOpcoes({
            variation_id: 77,
            variationOptions: [
              {
                shopee_option_id: 5,
                shopee_option_name: 'Azul',
                arakene_variation_id: ['v-azul', 'v-verde'],
              },
            ],
          }),
        ],
        filhos: doisFilhos,
      }),
    );
    expect(motivos(r.problemas)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada);
  });

  it('tier_index é posicional e sem buracos', () => {
    const tam = grupo({
      grupoId: 'g-tam',
      nome: 'Tamanho',
      ordem: 2,
      variacoes: [variante('v-p', 'P'), variante('v-m', 'M')],
    });
    const cor = comDuasOpcoes({ variation_id: 0 });
    const filhos = [
      filho({
        produtoId: 'p-azul-m',
        variacoesUid: [varianteFakePath('g-cor', 'v-azul'), varianteFakePath('g-tam', 'v-m')],
      }),
      filho({
        produtoId: 'p-verde-p',
        variacoesUid: [varianteFakePath('g-cor', 'v-verde'), varianteFakePath('g-tam', 'v-p')],
      }),
    ];
    const r = montarTiers(args({ grupos: [cor, tam], filhos }));
    expect(r.problemas).toEqual([]);
    expect(r.tiers.map((t) => t.grupoId)).toEqual(['g-cor', 'g-tam']);
    expect(r.modelos.map((m) => m.tier_index)).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2b) #1911 D12 — the shared key and the implicit CUSTOM tier              */
/* -------------------------------------------------------------------------- */

const TEXTO_ILEGIVEL = (grupoNome: string): string =>
  `O vínculo do grupo "${grupoNome}" com esta conta para a categoria ${String(CATEGORIA)} existe mas não pôde ser lido — corrija-o em Variações.`;

/**
 * S1 (#1911 P14b, P14a open point 5): a CUSTOM entry facing a live CUSTOM tier
 * (or nothing readable) — only a rename exits, so no «Importe».
 */
const TEXTO_NAO_CASA = (grupoNome: string): string =>
  `O tier "${grupoNome}" não casa pelo nome com nenhum tier do anúncio (grupo renomeado, ou anúncio exportado pelo app antigo) — republicar reescreveria as opções. Ajuste o nome do grupo em Variações, ou o do tier no Seller Centre, para que os dois fiquem iguais.`;

/**
 * S2 (#1911 P14b, P14 Q3(a)): a CUSTOM entry while every live tier left
 * unclaimed is STANDARD — bind first, or import; names THIS conta's category.
 */
const TEXTO_PADRAO_VIVO = (grupoNome: string, ids: string): string =>
  `Para esta conta e a categoria ${String(CATEGORIA)}, o grupo "${grupoNome}" não tem vínculo com a variação padronizada ${ids}, que o anúncio usa — republicar reescreveria as opções. Vincule o grupo a essa variação nessa categoria em Variações (aba Shopee), ou importe o anúncio.`;

function recusaPadraoViva(grupoNome: string, ids: string) {
  return {
    campo: 'standardise_tier_variation',
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
    mensagem: TEXTO_PADRAO_VIVO(grupoNome, ids),
  };
}

/**
 * The per-variante refusal of a grupo whose STANDARD entry binds no option to a
 * used variante, with the exit #1911 P14b added (§5-7) — the first verbatim pin.
 */
const TEXTO_VARIANTE_SEM_OPCAO = (
  varianteNome: string,
  grupoNome: string,
  variationId: number,
): string =>
  `A variante "${varianteNome}" do grupo "${grupoNome}" não está vinculada a nenhuma opção da variação padronizada ${String(variationId)}. Corrija o vínculo em Variações (aba Shopee): vincule a variante a uma opção dessa variação, troque o vínculo por outra variação ou remova-o.`;

/**
 * The per-variante refusal of an APPEND under a STANDARD entry paired BY NAME with
 * a live CUSTOM tier (#1911 P14b, Q1 — Lucas signed the sentence off on
 * 2026-11-11): the appended option would take the child's model. `tierNome` is the
 * LIVE tier's name as read; the flipped `⚠️ RECUSA (#1911 P14b, Q1)` test spells the
 * sentence out as a literal too.
 */
const TEXTO_ANEXO_SOB_PADRAO = (
  varianteNome: string,
  grupoNome: string,
  tierNome: string,
  variationId: number,
): string =>
  `A variante "${varianteNome}" do grupo "${grupoNome}" não casa pelo nome com nenhuma opção do tier personalizado "${tierNome}" do anúncio, e o vínculo do grupo usa a variação padronizada ${String(variationId)} — republicar acrescentaria uma opção e moveria o modelo. Renomeie a variante em Variações para o nome da opção do anúncio, ou mova as variações deste anúncio para outro grupo.`;

/** A STANDARD entry (`variation_id: 77`) binding both test variantes to options 5 / 6. */
function entradaPadrao(parcial: Parameters<typeof entrada>[0] = {}): unknown {
  return entrada({
    variation_id: 77,
    variationOptions: [
      { shopee_option_id: 5, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
      { shopee_option_id: 6, shopee_option_name: 'Verde', arakene_variation_id: ['v-verde'] },
    ],
    ...parcial,
  });
}

/**
 * The operator REBOUND the grupo to standard variation 88 (Azul → option 9). An
 * entry's `name` is the CATEGORY's label, so it differs from the grupo's here for
 * the #2043 sentence to show which of the two it interpolates.
 */
const ENTRADA_88 = {
  ...(entradaPadrao({
    variation_id: 88,
    variationOptions: [
      { shopee_option_id: 9, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
    ],
  }) as object),
  name: 'Camisetas',
};

/** The fixture's `variation_group_list: [1, 2]`: an element the strict schema REFUSES. */
function entradaQuebrada(parcial: Parameters<typeof entrada>[0] = {}): unknown {
  return { ...(entrada(parcial) as object), variation_group_list: [1, 2] };
}

/** The raw `grupoDeVariacoes` document the import reads for the Cor grupo of these suites. */
function docDoGrupoCor(
  id: string,
  nome: string,
  linksVariacoesShopee: readonly unknown[] | null,
): { readonly id: string; readonly raw: Record<string, unknown> } {
  return {
    id,
    raw: {
      nome,
      tipo: TIPO_VARIACAO.cor,
      variacoes: [
        { id: 'v-azul', nome: 'Azul' },
        { id: 'v-verde', nome: 'Verde' },
      ],
      variacoesIds: ['v-azul', 'v-verde'],
      linksVariacoesShopee,
    },
  };
}

/** The REAL import plan for this live tree, over these stored grupos. */
function reimportar(
  viva: ArvoreVivaDoItem,
  candidatos: readonly { readonly id: string; readonly raw: Record<string, unknown> }[],
): ReturnType<typeof planejarTaxonomia> {
  return planejarTaxonomia({
    tiers: tiersVivosDe(viva),
    modelos: [...viva.model],
    candidatos: [...candidatos],
    integracaoId: INTEGRACAO,
    categoryId: CATEGORIA,
    nomeCategoria: 'Camisetas',
    nowMs: 1,
  });
}

/** The live STANDARD tier 77 = [Verde(6) @0, Azul(5) @1], a model on each. */
function arvorePadrao77(modelos: readonly ShopeeModel[]): ArvoreVivaDoItem {
  return {
    tier_variation: [
      shopeeTierVariationSchema.parse({
        name: 'Cor',
        option_list: [{ option: 'Verde' }, { option: 'Azul' }],
      }),
    ],
    standardise_tier_variation: [
      shopeeStandardiseTierVariationSchema.parse({
        variation_id: 77,
        variation_name: 'Cor',
        variation_option_list: [
          { variation_option_id: 6, variation_option_name: 'Verde' },
          { variation_option_id: 5, variation_option_name: 'Azul' },
        ],
      }),
    ],
    model: modelos,
  };
}

describe('montarTiers — #1911 (D12): sem vínculo para o par, o tier CUSTOM implícito', () => {
  const azul = variante('v-azul', 'Azul');
  const verde = variante('v-verde', 'Verde');
  /** Named NOT 'Cor' — the stored entry's `name` — so a tier named after the entry shows. */
  const NOME_DO_GRUPO = 'Estampa';

  function comLinks(linksVariacoesShopee: readonly unknown[] | null): GrupoParaTier {
    return grupo({
      grupoId: 'g-est',
      nome: NOME_DO_GRUPO,
      variacoes: [azul, verde],
      linksVariacoesShopee,
    });
  }

  const doisFilhos: readonly FilhoParaPublicar[] = [
    filho({ produtoId: 'p-1', variacoesUid: [varianteFakePath('g-est', 'v-azul')] }),
    filho({ produtoId: 'p-2', variacoesUid: [varianteFakePath('g-est', 'v-verde')] }),
  ];

  const TIER_CUSTOM = {
    grupoId: 'g-est',
    variation_id: 0,
    variation_group_id: null,
    variation_name: NOME_DO_GRUPO,
    opcoes: [
      {
        varianteId: 'v-azul',
        variation_option_id: 0,
        variation_option_name: 'Azul',
        image_id: null,
        ocupadaPorModeloSemFilho: false,
      },
      {
        varianteId: 'v-verde',
        variation_option_id: 0,
        variation_option_name: 'Verde',
        image_id: null,
        ocupadaPorModeloSemFilho: false,
      },
    ],
  };

  it('⚠️ PAR: nenhum elemento (null ou []) ⇒ UM tier custom com o nome do GRUPO, opções de id 0 com o nome da variante — antes do #1911 era variacao-sem-vinculo', () => {
    for (const links of [null, []]) {
      const r = montarTiers(args({ grupos: [comLinks(links)], filhos: doisFilhos }));
      expect(r.problemas).toEqual([]);
      expect(r.tiers).toEqual([TIER_CUSTOM]);
      expect(r.modelos.map((m) => [m.produtoId, m.tier_index])).toEqual([
        ['p-1', [0]],
        ['p-2', [1]],
      ]);
    }
  });

  it('a entrada de OUTRA categoria, ou de uma conta que só COMEÇA igual, não é a do par ⇒ o mesmo tier custom', () => {
    for (const links of [
      [entradaPadrao({ category_id: 999999 })],
      [entradaPadrao({ integracaoShopeeId: 'int-12' })],
      [entradaPadrao({ integracaoShopeeId: 'documents/integracao/int-12' })],
    ]) {
      const r = montarTiers(args({ grupos: [comLinks(links)], filhos: doisFilhos }));
      expect(r.problemas).toEqual([]);
      expect(r.tiers).toEqual([TIER_CUSTOM]);
    }
    // ... e no sentido inverso: a conta 'int-12' não lê a entrada de 'int-1'.
    const inverso = montarTiers(
      args({ integracaoId: 'int-12', grupos: [comLinks([entradaPadrao()])], filhos: doisFilhos }),
    );
    expect(inverso.problemas).toEqual([]);
    expect(inverso.tiers).toEqual([TIER_CUSTOM]);
  });

  it("⚠️ QUASE: 'documents/integracao/int-1' É a conta 'int-1' ⇒ a entrada PADRÃO armazenada vale, com os ids dela", () => {
    for (const integracaoShopeeId of ['int-1', 'documents/integracao/int-1']) {
      const r = montarTiers(
        args({
          grupos: [comLinks([entradaPadrao({ integracaoShopeeId, variation_group_list: 9 })])],
          filhos: doisFilhos,
        }),
      );
      expect(r.problemas).toEqual([]);
      expect(r.tiers.map((t) => [t.variation_id, t.variation_group_id, t.variation_name])).toEqual([
        [77, 9, null],
      ]);
      expect(
        r.tiers[0]!.opcoes.map((o) => [o.variation_option_id, o.variation_option_name]),
      ).toEqual([
        [5, 'Azul'],
        [6, 'Verde'],
      ]);
    }
  });

  it('⚠️ QUASE: um elemento que NOMEIA o par mas não pôde ser lido RECUSA — nunca cai no custom', () => {
    const r = montarTiers(args({ grupos: [comLinks([entradaQuebrada()])], filhos: doisFilhos }));
    expect(r.problemas).toEqual([
      {
        campo: 'standardise_tier_variation',
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
        mensagem: TEXTO_ILEGIVEL(NOME_DO_GRUPO),
      },
    ]);
    expect(r.tiers).toEqual([]);
    expect(r.modelos).toEqual([]);
  });

  it('⛔ par do anterior: o MESMO elemento ilegível de OUTRA conta ou OUTRA categoria não é do par ⇒ tier custom', () => {
    for (const links of [
      [entradaQuebrada({ integracaoShopeeId: 'int-12' })],
      [entradaQuebrada({ category_id: 999999 })],
    ]) {
      const r = montarTiers(args({ grupos: [comLinks(links)], filhos: doisFilhos }));
      expect(r.problemas).toEqual([]);
      expect(r.tiers).toEqual([TIER_CUSTOM]);
    }
  });

  it('um elemento ilegível ANTES de uma entrada legível do par não a esconde', () => {
    const r = montarTiers(
      args({ grupos: [comLinks([entradaQuebrada(), entradaPadrao()])], filhos: doisFilhos }),
    );
    expect(r.problemas).toEqual([]);
    expect(r.tiers.map((t) => t.variation_id)).toEqual([77]);
  });

  it('uma entrada CUSTOM armazenada continua valendo — e o tier se chama grupo.nome, nunca o name da entrada', () => {
    // `entrada({})` carries `name: 'Cor'` — the CATEGORY's label, not the tier's.
    const r = montarTiers(args({ grupos: [comLinks([entrada({})])], filhos: doisFilhos }));
    expect(r.problemas).toEqual([]);
    expect(r.tiers).toEqual([TIER_CUSTOM]);
  });

  it('o limite de opções é o MESMO no tier implícito: 50 aceitas, 51 viram opcoes-demais', () => {
    function comN(n: number) {
      const variacoes = Array.from({ length: n }, (_, i) =>
        variante(`v-${String(i)}`, `Cor ${String(i)}`),
      );
      return montarTiers(
        args({
          grupos: [grupo({ grupoId: 'g-est', variacoes, linksVariacoesShopee: null })],
          filhos: variacoes.map((v, i) =>
            filho({
              produtoId: `p-${String(i)}`,
              variacoesUid: [varianteFakePath('g-est', v.varianteId)],
            }),
          ),
        }),
      );
    }
    const cinquenta = comN(SHOPEE_TIER_MAX_OPTIONS);
    expect(cinquenta.problemas).toEqual([]);
    expect(cinquenta.tiers[0]!.opcoes).toHaveLength(50);
    expect(cinquenta.tiers[0]!.variation_id).toBe(0);

    const demais = comN(SHOPEE_TIER_MAX_OPTIONS + 1).problemas.filter(
      (p) => p.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.opcoesDemais,
    );
    // 51 children are also 51 models, past the item cap: both bounds speak.
    expect(demais.map((p) => p.mensagem)).toEqual([
      `O grupo "Cor" ficaria com 51 opções; a Shopee aceita no máximo ${String(SHOPEE_TIER_MAX_OPTIONS)}.`,
      `51 modelos; a Shopee aceita no máximo ${String(SHOPEE_MODEL_MAX_PER_ITEM)} por item.`,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2c) #1911 Q2 — on an UPDATE, a custom tier that does not pair is REFUSED */
/* -------------------------------------------------------------------------- */

describe('montarTiers — #1911 (Q2): na ATUALIZAÇÃO, um tier custom que não casa pelo nome é RECUSADO', () => {
  const azul = variante('v-azul', 'Azul');
  const verde = variante('v-verde', 'Verde');
  const VERDE = MODEL_ID;
  const AZUL = MODEL_ID + 1;

  /** Live CUSTOM tiers (no standardise tree), each with its options in wire order. */
  function arvoreDeTiers(
    tiers: readonly { readonly nome: string; readonly opcoes: readonly string[] }[],
    modelos: readonly ShopeeModel[],
  ): ArvoreVivaDoItem {
    return {
      tier_variation: tiers.map((t) =>
        shopeeTierVariationSchema.parse({
          name: t.nome,
          option_list: t.opcoes.map((option) => ({ option })),
        }),
      ),
      standardise_tier_variation: null,
      model: modelos,
    };
  }

  /** The live listing: tier 'Cor' = [Verde, Azul], one model on each. */
  const VIVA_COR = arvoreDeTiers(
    [{ nome: 'Cor', opcoes: ['Verde', 'Azul'] }],
    [
      modeloVivo({ model_id: VERDE, tier_index: [0], model_sku: 'VD' }),
      modeloVivo({ model_id: AZUL, tier_index: [1], model_sku: 'AZ' }),
    ],
  );

  const filhosCor: readonly FilhoParaPublicar[] = [
    filho({
      produtoId: 'p-azul',
      sku: 'AZ',
      linkDocId: 'l-azul',
      variacoesUid: [varianteFakePath('g-cor', 'v-azul')],
    }),
    filho({
      produtoId: 'p-verde',
      sku: 'VD',
      linkDocId: 'l-verde',
      variacoesUid: [varianteFakePath('g-cor', 'v-verde')],
    }),
  ];

  const armazenadosCor: readonly ModeloArmazenado[] = [
    { produtoId: 'p-azul', linkDocId: 'l-azul', modelId: AZUL, modelSku: 'AZ', tierIndex: [1] },
    { produtoId: 'p-verde', linkDocId: 'l-verde', modelId: VERDE, modelSku: 'VD', tierIndex: [0] },
  ];

  /** The import-written shape: a STORED custom entry naming each option. */
  const ENTRADA_IMPORTADA = entrada({
    variation_id: 0,
    variationOptions: [
      { shopee_option_id: 0, shopee_option_name: 'Verde', arakene_variation_id: ['v-verde'] },
      { shopee_option_id: 0, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
    ],
  });

  function grupoCor(nome: string, linksVariacoesShopee: readonly unknown[] | null): GrupoParaTier {
    return grupo({ grupoId: 'g-cor', nome, variacoes: [azul, verde], linksVariacoesShopee });
  }

  function recusaNaoCasa(grupoNome: string) {
    return {
      campo: 'standardise_tier_variation',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
      mensagem: TEXTO_NAO_CASA(grupoNome),
    };
  }

  it('⚠️ PAR: casado pelo nome IGUAL ⇒ as opções e os índices vivos ficam — implícito OU entrada importada', () => {
    for (const links of [null, [ENTRADA_IMPORTADA]]) {
      const r = montarTiers(
        args({ grupos: [grupoCor('Cor', links)], filhos: filhosCor, viva: VIVA_COR }),
      );
      expect(r.problemas).toEqual([]);
      expect(r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_name])).toEqual([
        ['v-verde', 'Verde'],
        ['v-azul', 'Azul'],
      ]);
      expect(r.modelos.map((m) => [m.produtoId, m.tier_index])).toEqual([
        ['p-azul', [1]],
        ['p-verde', [0]],
      ]);

      const plano = reconciliarModelos({
        montados: r.modelos,
        armazenados: armazenadosCor,
        viva: VIVA_COR,
        profundidadeNossa: r.tiers.length,
      });
      expect(plano.acao).toBe('nenhuma');
      expect(plano.modelList).toEqual([
        { model_id: VERDE, tier_index: [0] },
        { model_id: AZUL, tier_index: [1] },
      ]);
    }
  });

  it("⚠️ PAR (#1911 batch-A, INVERTIDO DE PROPÓSITO): 'Cor ' e ' Cor' CASAM com o 'Cor' vivo — as pontas dobram dos dois lados, e o que vai ao fio é 'Cor'", () => {
    // Until the batch-A review this pinned 'Cor ' ≠ 'Cor' as a near-miss. It was
    // the defect: the reader trims, and this app's own create SENT 'Cor ', so
    // every update of a listing it had created was refused. The fold now runs on
    // both sides, and the near-misses it must NOT reach are case and inner space.
    for (const nome of ['Cor ', ' Cor', '\u00a0Cor\u00a0']) {
      const r = montarTiers(
        args({ grupos: [grupoCor(nome, null)], filhos: filhosCor, viva: VIVA_COR }),
      );
      expect(r.problemas, JSON.stringify(nome)).toEqual([]);
      expect(r.tiers.map((t) => t.variation_name)).toEqual(['Cor']);
      expect(r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_name])).toEqual([
        ['v-verde', 'Verde'],
        ['v-azul', 'Azul'],
      ]);
      const plano = reconciliarModelos({
        montados: r.modelos,
        armazenados: armazenadosCor,
        viva: VIVA_COR,
        profundidadeNossa: r.tiers.length,
      });
      expect(plano.acao, JSON.stringify(nome)).toBe('nenhuma');
    }
  });

  it("⚠️ QUASE: 'cor' (a CAIXA) e 'C or' (o espaço de DENTRO) NÃO são 'Cor' ⇒ o tier implícito que não casa é RECUSADO, nada é montado", () => {
    for (const nome of ['cor', 'COR', 'C or']) {
      const r = montarTiers(
        args({ grupos: [grupoCor(nome, null)], filhos: filhosCor, viva: VIVA_COR }),
      );
      expect(r.problemas, nome).toEqual([recusaNaoCasa(nome)]);
      expect(r.tiers, nome).toEqual([]);
      expect(r.modelos, nome).toEqual([]);
    }
  });

  it('⚠️ QUASE (Q2): uma entrada variation_id 0 ARMAZENADA (escrita pela importação) que não casa também é RECUSADA', () => {
    // The legacy export named its custom tiers by `tipo`, so a migrated listing
    // reads 'Cor' while the ERP grupo is 'Cores'.
    const r = montarTiers(
      args({
        grupos: [grupoCor('Cores', [ENTRADA_IMPORTADA])],
        filhos: filhosCor,
        viva: VIVA_COR,
      }),
    );
    expect(r.problemas).toEqual([recusaNaoCasa('Cores')]);
    expect(r.tiers).toEqual([]);
  });

  it('um tier PADRÃO vivo não é casado pelo fallback implícito ⇒ na mesma profundidade, RECUSADO', () => {
    const viva: ArvoreVivaDoItem = {
      tier_variation: [
        shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
      ],
      standardise_tier_variation: [
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: 77,
          variation_name: 'Cor',
          variation_option_list: [{ variation_option_id: 5, variation_option_name: 'Azul' }],
        }),
      ],
      model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
    };
    const implicito = montarTiers(
      args({ grupos: [grupoCor('Cor', null)], filhos: [filhosCor[0]!], viva }),
    );
    // #1911 P14b: the live tier left unclaimed is STANDARD, so the sentence is S2
    // (bind it, or import) — a rename could never make this grupo claim it.
    expect(implicito.problemas).toEqual([recusaPadraoViva('Cor', '77')]);

    // ⛔ par: a entrada PADRÃO armazenada com o mesmo variation_id casa e publica.
    const padrao = montarTiers(
      args({ grupos: [grupoCor('Cor', [entradaPadrao()])], filhos: [filhosCor[0]!], viva }),
    );
    expect(padrao.problemas).toEqual([]);
    expect(padrao.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_id])).toEqual([
      ['v-azul', 5],
    ]);
  });

  it('⚠️ QUASE (Q2): uma entrada variation_id 0 ARMAZENADA também não reivindica um tier PADRÃO vivo ⇒ RECUSADA', () => {
    // Only a stored entry carrying the live tier's OWN non-zero id claims it. A
    // stored custom entry (the import's shape) that claimed it would re-send a
    // CUSTOM tier over the standard one, in place, at the live positions — the
    // very re-code Q2 refuses. (Verifier: the mutant "any stored entry claims a
    // standard live tier" survived the suite without this test.)
    const viva: ArvoreVivaDoItem = {
      tier_variation: [
        shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
      ],
      standardise_tier_variation: [
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: 77,
          variation_name: 'Cor',
          variation_option_list: [{ variation_option_id: 5, variation_option_name: 'Azul' }],
        }),
      ],
      model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
    };
    const r = montarTiers(
      args({ grupos: [grupoCor('Cor', [ENTRADA_IMPORTADA])], filhos: [filhosCor[0]!], viva }),
    );
    // #1911 P14b: S2 — the live tier left unclaimed is STANDARD.
    expect(r.problemas).toEqual([recusaPadraoViva('Cor', '77')]);
    expect(r.tiers).toEqual([]);
    expect(r.modelos).toEqual([]);
  });

  it('o PAREAMENTO de um tier padrão lê a chave compartilhada com a conta e a folha DESTA publicação', () => {
    // The live standard tier holds [Verde(6), Azul(5)] with a model on each; only
    // `v-azul` is published. Paired, the live list is the base and the child sits
    // at index 1; unpaired, the grupo is refused (#2043), since rebuilding the tier
    // as [Azul] would re-code the live models.
    const viva: ArvoreVivaDoItem = {
      tier_variation: [
        shopeeTierVariationSchema.parse({
          name: 'Cor',
          option_list: [{ option: 'Verde' }, { option: 'Azul' }],
        }),
      ],
      standardise_tier_variation: [
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: 77,
          variation_name: 'Cor',
          variation_option_list: [
            { variation_option_id: 6, variation_option_name: 'Verde' },
            { variation_option_id: 5, variation_option_name: 'Azul' },
          ],
        }),
      ],
      model: [
        modeloVivo({ model_id: VERDE, tier_index: [0], model_sku: 'VD' }),
        modeloVivo({ model_id: AZUL, tier_index: [1], model_sku: 'AZ' }),
      ],
    };
    const casos = [
      { integracaoId: 'int-1', categoryId: CATEGORIA, armazenado: 'documents/integracao/int-1' },
      { integracaoId: 'int-12', categoryId: 100002, armazenado: 'int-12' },
    ];
    for (const { integracaoId, categoryId, armazenado } of casos) {
      const r = montarTiers(
        args({
          integracaoId,
          categoryId,
          grupos: [
            grupoCor('Cor', [
              entradaPadrao({ integracaoShopeeId: armazenado, category_id: categoryId }),
            ]),
          ],
          filhos: [filhosCor[0]!],
          viva,
        }),
      );
      expect(r.problemas).toEqual([]);
      expect(r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_id])).toEqual([
        ['v-verde', 6],
        ['v-azul', 5],
      ]);
      expect(r.modelos.map((m) => m.tier_index)).toEqual([[1]]);
    }
  });

  it('com dois tiers vivos, só o grupo que não casa é recusado — e nenhum modelo é colocado', () => {
    const viva = arvoreDeTiers(
      [
        { nome: 'Cor', opcoes: ['Azul'] },
        { nome: 'Tamanho', opcoes: ['P'] },
      ],
      [modeloVivo({ model_id: AZUL, tier_index: [0, 0], model_sku: 'AZ-P' })],
    );
    const r = montarTiers(
      args({
        grupos: [
          grupoCor('Cor', null),
          grupo({
            grupoId: 'g-tam',
            nome: 'Tamanhos',
            ordem: 2,
            variacoes: [variante('v-p', 'P')],
            linksVariacoesShopee: null,
          }),
        ],
        filhos: [
          filho({
            produtoId: 'p-azul-p',
            variacoesUid: [varianteFakePath('g-cor', 'v-azul'), varianteFakePath('g-tam', 'v-p')],
          }),
        ],
        viva,
      }),
    );
    expect(r.problemas).toEqual([recusaNaoCasa('Tamanhos')]);
    expect(r.tiers.map((t) => t.grupoId)).toEqual(['g-cor']);
    expect(r.modelos).toEqual([]);
  });

  it('⚠️ QUASE: mudança de profundidade 1→2 NÃO é recusada — é init_tier_variation', () => {
    const viva = arvoreDeTiers(
      [{ nome: 'Cor', opcoes: ['Azul'] }],
      [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
    );
    const tam = grupo({
      grupoId: 'g-tam',
      nome: 'Tamanho',
      ordem: 2,
      variacoes: [variante('v-p', 'P')],
      linksVariacoesShopee: null,
    });
    const r = montarTiers(
      args({
        grupos: [grupoCor('Cor', null), tam],
        filhos: [
          filho({
            produtoId: 'p-azul-p',
            variacoesUid: [varianteFakePath('g-cor', 'v-azul'), varianteFakePath('g-tam', 'v-p')],
          }),
        ],
        viva,
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(r.tiers.map((t) => [t.grupoId, t.variation_name])).toEqual([
      ['g-cor', 'Cor'],
      ['g-tam', 'Tamanho'],
    ]);
    const plano = reconciliarModelos({
      montados: r.modelos,
      armazenados: [],
      viva,
      profundidadeNossa: r.tiers.length,
    });
    expect(plano).toMatchObject({ acao: 'init', mudouProfundidade: true });
  });

  it('⚠️ QUASE: mudança de profundidade 2→1 NÃO é recusada — é init_tier_variation', () => {
    const viva = arvoreDeTiers(
      [
        { nome: 'Cor', opcoes: ['Azul'] },
        { nome: 'Tamanho', opcoes: ['P'] },
      ],
      [modeloVivo({ model_id: AZUL, tier_index: [0, 0], model_sku: 'AZ-P' })],
    );
    const r = montarTiers(
      args({ grupos: [grupoCor('Estampa', null)], filhos: [filhosCor[0]!], viva }),
    );
    expect(r.problemas).toEqual([]);
    expect(r.tiers.map((t) => t.variation_name)).toEqual(['Estampa']);
    const plano = reconciliarModelos({
      montados: r.modelos,
      armazenados: [],
      viva,
      profundidadeNossa: r.tiers.length,
    });
    expect(plano).toMatchObject({ acao: 'init', mudouProfundidade: true });
  });

  it('⚠️ QUASE: na mesma profundidade mas SEM modelo endereçável, não há o que recodificar ⇒ init, sem recusa', () => {
    for (const modelos of [[], [modeloVivo({ model_id: 0, tier_index: [0] })]]) {
      const viva = arvoreDeTiers([{ nome: 'Cor', opcoes: ['Verde', 'Azul'] }], modelos);
      const r = montarTiers(args({ grupos: [grupoCor('Cores', null)], filhos: filhosCor, viva }));
      expect(r.problemas).toEqual([]);
      const plano = reconciliarModelos({
        montados: r.modelos,
        armazenados: [],
        viva,
        profundidadeNossa: r.tiers.length,
      });
      expect(plano.acao).toBe('init');
    }
  });

  describe('modelos vivos sem NENHUM tier legível: a profundidade viva sai do tier_index dos modelos', () => {
    // No committed `get_model_list` with models lacks its tiers, but the package's
    // schema tolerates every combination. When none can be read — both trees
    // absent, every tier nameless and dropped by `tiersDoItem`, or only the
    // standard tree present — there is nothing to pair with, but the live DEPTH is
    // still read, from the models' `tier_index` (from the tree length only when
    // every `tier_index` is empty). At OUR depth the leg would update in place, so
    // any grupo is refused, custom or standard; at another depth it is
    // `init_tier_variation`, which re-creates every model, and nothing is refused.
    const arvores: readonly {
      readonly rotulo: string;
      readonly tier_variation: ArvoreVivaDoItem['tier_variation'];
    }[] = [
      { rotulo: 'as duas árvores ausentes', tier_variation: null },
      {
        rotulo: 'um tier SEM NOME (tiersDoItem o descarta)',
        tier_variation: [
          shopeeTierVariationSchema.parse({ name: '', option_list: [{ option: 'Azul' }] }),
        ],
      },
    ];
    const tam = grupo({
      grupoId: 'g-tam',
      nome: 'Tamanho',
      ordem: 2,
      variacoes: [variante('v-p', 'P')],
      linksVariacoesShopee: null,
    });

    for (const { rotulo, tier_variation } of arvores) {
      it(`${rotulo}, tier_index [0] e a NOSSA profundidade 1 ⇒ RECUSADO`, () => {
        const viva: ArvoreVivaDoItem = {
          tier_variation,
          standardise_tier_variation: null,
          model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
        };
        const r = montarTiers(
          args({ grupos: [grupoCor('Cor', [ENTRADA_IMPORTADA])], filhos: [filhosCor[0]!], viva }),
        );
        expect(r.problemas).toEqual([recusaNaoCasa('Cor')]);
      });

      it(`⚠️ QUASE: ${rotulo}, tier_index [0] e a nossa profundidade 2 ⇒ SEM recusa — é init_tier_variation`, () => {
        const viva: ArvoreVivaDoItem = {
          tier_variation,
          standardise_tier_variation: null,
          model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
        };
        const r = montarTiers(
          args({
            grupos: [grupoCor('Cor', null), tam],
            filhos: [
              filho({
                produtoId: 'p-azul-p',
                variacoesUid: [
                  varianteFakePath('g-cor', 'v-azul'),
                  varianteFakePath('g-tam', 'v-p'),
                ],
              }),
            ],
            viva,
          }),
        );
        expect(r.problemas).toEqual([]);
        const plano = reconciliarModelos({
          montados: r.modelos,
          armazenados: [],
          viva,
          profundidadeNossa: r.tiers.length,
        });
        expect(plano).toMatchObject({ acao: 'init', mudouProfundidade: true });
      });

      it(`${rotulo}, entrada PADRÃO 88, tier_index [0] e a NOSSA profundidade 1 ⇒ RECUSADO com a frase do vínculo`, () => {
        const viva: ArvoreVivaDoItem = {
          tier_variation,
          standardise_tier_variation: null,
          model: [
            modeloVivo({ model_id: VERDE, tier_index: [0], model_sku: 'VD' }),
            modeloVivo({ model_id: AZUL, tier_index: [1], model_sku: 'AZ' }),
          ],
        };
        const r = montarTiers(
          args({ grupos: [grupoCor('Cor', [ENTRADA_88])], filhos: [filhosCor[0]!], viva }),
        );
        expect(r.problemas).toEqual([
          {
            campo: 'standardise_tier_variation',
            motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
            mensagem: TEXTO_PADRAO_NAO_CASA('Cor', 88),
          },
        ]);
        expect(r.tiers).toEqual([]);
        expect(r.modelos).toEqual([]);
      });

      it(`⚠️ QUASE: ${rotulo}, entrada PADRÃO 88 e a nossa profundidade 2 ⇒ SEM recusa — é init_tier_variation`, () => {
        const viva: ArvoreVivaDoItem = {
          tier_variation,
          standardise_tier_variation: null,
          model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
        };
        const r = montarTiers(
          args({
            grupos: [grupoCor('Cor', [ENTRADA_88]), tam],
            filhos: [
              filho({
                produtoId: 'p-azul-p',
                variacoesUid: [
                  varianteFakePath('g-cor', 'v-azul'),
                  varianteFakePath('g-tam', 'v-p'),
                ],
              }),
            ],
            viva,
          }),
        );
        expect(r.problemas).toEqual([]);
        const plano = reconciliarModelos({
          montados: r.modelos,
          armazenados: [],
          viva,
          profundidadeNossa: r.tiers.length,
        });
        expect(plano).toMatchObject({ acao: 'init', mudouProfundidade: true });
      });
    }

    it('nenhuma profundidade legível (árvores ausentes, tier_index vazio) ⇒ RECUSADO em QUALQUER profundidade nossa', () => {
      const viva: ArvoreVivaDoItem = {
        tier_variation: null,
        standardise_tier_variation: null,
        model: [modeloVivo({ model_id: AZUL, tier_index: [], model_sku: 'AZ' })],
      };
      const um = montarTiers(
        args({ grupos: [grupoCor('Cor', null)], filhos: [filhosCor[0]!], viva }),
      );
      expect(um.problemas).toEqual([recusaNaoCasa('Cor')]);
      const dois = montarTiers(
        args({
          grupos: [grupoCor('Cor', null), tam],
          filhos: [
            filho({
              produtoId: 'p-azul-p',
              variacoesUid: [varianteFakePath('g-cor', 'v-azul'), varianteFakePath('g-tam', 'v-p')],
            }),
          ],
          viva,
        }),
      );
      expect(dois.problemas).toEqual([recusaNaoCasa('Cor'), recusaNaoCasa('Tamanho')]);
    });
  });

  it('um CREATE (sem árvore viva) nunca passa pela guarda, qualquer que seja o nome', () => {
    for (const viva of [null, undefined]) {
      const r = montarTiers(
        args({ grupos: [grupoCor('Cores', [ENTRADA_IMPORTADA])], filhos: filhosCor, viva }),
      );
      expect(r.problemas).toEqual([]);
      expect(r.tiers.map((t) => t.variation_name)).toEqual(['Cores']);
    }
  });

  describe('reimportar o anúncio: o que a frase do Q2 pode prometer', () => {
    // The Q2 sentence used to say "Importe o anúncio ou ajuste o nome do grupo" for
    // both live kinds; #1911 P14b split it by the half that works (module header):
    // facing a live CUSTOM tier S1 names only the rename, because the import cannot
    // heal it; facing a live STANDARD tier S2 names the binding, then the import.
    // Each case runs the REAL import plan, applies its patch to the grupo, and
    // publishes again. Both halves of the fold: what the import heals, and what it
    // cannot reach.
    const VIVA_77 = arvorePadrao77([
      modeloVivo({ model_id: VERDE, tier_index: [0], model_sku: 'VD' }),
      modeloVivo({ model_id: AZUL, tier_index: [1], model_sku: 'AZ' }),
    ]);

    /** The grupo as the publisher reads it after the import's patch landed. */
    function depoisDoPatch(
      doc: ReturnType<typeof docDoGrupoCor>,
      patch: Readonly<Record<string, unknown>> | null | undefined,
    ): GrupoParaTier {
      const depois = { ...doc.raw, ...patch };
      return grupoCor(
        depois.nome as string,
        depois.linksVariacoesShopee as readonly unknown[] | null,
      );
    }

    it('⚠️ QUASE: reimportar NÃO tira da recusa um tier CUSTOM vivo — o patch não nomeia `nome`, e a recusa é a mesma', () => {
      const doc = docDoGrupoCor('g-cor', 'Cores', [ENTRADA_IMPORTADA]);
      const antes = montarTiers(
        args({
          grupos: [grupoCor('Cores', [ENTRADA_IMPORTADA])],
          filhos: filhosCor,
          viva: VIVA_COR,
        }),
      );
      expect(antes.problemas).toEqual([recusaNaoCasa('Cores')]);

      const plano = reimportar(VIVA_COR, [doc]);
      expect(plano.grupos.map((g) => [g.grupoId, g.criar])).toEqual([['g-cor', false]]);
      const patch = plano.grupos[0]?.patch;
      expect(patch).not.toBeNull();
      expect(patch).not.toHaveProperty('nome');

      const depois = montarTiers(
        args({ grupos: [depoisDoPatch(doc, patch)], filhos: filhosCor, viva: VIVA_COR }),
      );
      expect(depois.problemas).toEqual([recusaNaoCasa('Cores')]);
      // #1911 P14b (P14a open point 5): so S1 must not offer the import at all.
      expect(depois.problemas[0]?.mensagem).not.toContain('Importe');
      expect(depois.problemas[0]?.mensagem).not.toContain('importe');
    });

    it('⚠️ PAR: reimportar cura o tier PADRÃO vivo — um 0 armazenado ou uma entrada ausente, no grupo em que a cascata cai', () => {
      for (const links of [[ENTRADA_IMPORTADA], null]) {
        const doc = docDoGrupoCor('g-cor', 'Cor', links);
        const antes = montarTiers(
          args({ grupos: [grupoCor('Cor', links)], filhos: filhosCor, viva: VIVA_77 }),
        );
        // #1911 P14b: S2 — the second exit it names is this very import.
        expect(antes.problemas).toEqual([recusaPadraoViva('Cor', '77')]);

        const plano = reimportar(VIVA_77, [doc]);
        expect(plano.grupos.map((g) => g.grupoId)).toEqual(['g-cor']);

        const depois = montarTiers(
          args({
            grupos: [depoisDoPatch(doc, plano.grupos[0]?.patch)],
            filhos: filhosCor,
            viva: VIVA_77,
          }),
        );
        expect(depois.problemas).toEqual([]);
        expect(depois.tiers.map((t) => t.variation_id)).toEqual([77]);
        // #1911 P14b (#2108 point 8): a stored `0` is still THIS variation's, so the
        // heal still appends 77's rows and each live option keeps its own variante.
        expect(
          depois.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_id]),
          JSON.stringify(links),
        ).toEqual([
          ['v-verde', 6],
          ['v-azul', 5],
        ]);
      }
    });

    it('⚠️ QUASE: com um grupo shopee-<id> na memória, a cura não chega ao grupo recusado — ele continua recusado', () => {
      const doc = docDoGrupoCor('g-cor', 'Cor', [ENTRADA_IMPORTADA]);
      const plano = reimportar(VIVA_77, [doc, docDoGrupoCor('shopee-77', 'Outra Cor', null)]);
      // The cascade lands on the id, so nothing is planned for g-cor; an existing
      // child's `variacoesUid` is fill-only, so the publisher still reads g-cor.
      expect(plano.grupos.map((g) => g.grupoId)).toEqual(['shopee-77']);
      const depois = montarTiers(
        args({
          grupos: [grupoCor('Cor', [ENTRADA_IMPORTADA])],
          filhos: filhosCor,
          viva: VIVA_77,
        }),
      );
      expect(depois.problemas).toEqual([recusaPadraoViva('Cor', '77')]);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  (2c-ter) #1911 P14b — the custom grupo's sentence follows the live tier   */
/*  left unclaimed: S1 (rename) or S2 (bind, or import)                       */
/* -------------------------------------------------------------------------- */

describe('montarTiers — #1911 P14b (Q3a + aberto 5): a frase do grupo CUSTOM sem par segue o tier vivo que sobrou', () => {
  const azul = variante('v-azul', 'Azul');
  const verde = variante('v-verde', 'Verde');
  const AZUL = MODEL_ID + 1;
  const VERDE = MODEL_ID;

  const VIVA_77 = arvorePadrao77([
    modeloVivo({ model_id: VERDE, tier_index: [0], model_sku: 'VD' }),
    modeloVivo({ model_id: AZUL, tier_index: [1], model_sku: 'AZ' }),
  ]);

  /** A live CUSTOM tier 'Cor' = [Verde, Azul], a model on each. */
  const VIVA_COR: ArvoreVivaDoItem = {
    tier_variation: [
      shopeeTierVariationSchema.parse({
        name: 'Cor',
        option_list: [{ option: 'Verde' }, { option: 'Azul' }],
      }),
    ],
    standardise_tier_variation: null,
    model: [
      modeloVivo({ model_id: VERDE, tier_index: [0], model_sku: 'VD' }),
      modeloVivo({ model_id: AZUL, tier_index: [1], model_sku: 'AZ' }),
    ],
  };

  function grupoCor(nome: string, linksVariacoesShopee: readonly unknown[] | null): GrupoParaTier {
    return grupo({ grupoId: 'g-cor', nome, variacoes: [azul, verde], linksVariacoesShopee });
  }

  const SO_AZUL: readonly FilhoParaPublicar[] = [
    filho({ produtoId: 'p-azul', variacoesUid: [varianteFakePath('g-cor', 'v-azul')] }),
  ];

  /** Two live tiers, each custom (`variationId: 0`) or standard, one model at [0, 0]. */
  function vivaDeDoisTiers(
    tiers: readonly { readonly nome: string; readonly variationId: number }[],
  ): ArvoreVivaDoItem {
    return {
      tier_variation: tiers.map((t) =>
        shopeeTierVariationSchema.parse({ name: t.nome, option_list: [{ option: 'Única' }] }),
      ),
      standardise_tier_variation: tiers.map((t) =>
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: t.variationId,
          variation_name: t.nome,
          variation_option_list: [
            { variation_option_id: t.variationId === 0 ? 0 : 1, variation_option_name: 'Única' },
          ],
        }),
      ),
      model: [modeloVivo({ model_id: AZUL, tier_index: [0, 0], model_sku: 'U-U' })],
    };
  }

  /** Two IMPLICIT grupos (no entry) of one variante each, and the child using both. */
  function doisGruposImplicitos(nomeA: string, nomeB: string) {
    return {
      grupos: [
        grupo({
          grupoId: 'g-a',
          nome: nomeA,
          ordem: 1,
          variacoes: [variante('v-a', 'Única')],
          linksVariacoesShopee: null,
        }),
        grupo({
          grupoId: 'g-b',
          nome: nomeB,
          ordem: 2,
          variacoes: [variante('v-b', 'Única')],
          linksVariacoesShopee: null,
        }),
      ],
      filhos: [
        filho({
          produtoId: 'p-ab',
          variacoesUid: [varianteFakePath('g-a', 'v-a'), varianteFakePath('g-b', 'v-b')],
        }),
      ],
    };
  }

  const recusaS1 = (grupoNome: string) => ({
    campo: 'standardise_tier_variation',
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
    mensagem: TEXTO_NAO_CASA(grupoNome),
  });

  it('⚠️ PAR (Q3a): a entrada PADRÃO 77 casa com o tier vivo 77; o MESMO grupo sem ela (removida no editor — nenhuma, [] ou um 0 armazenado) recebe S2 nomeando 77, e nada é montado', () => {
    const casado = montarTiers(
      args({ grupos: [grupoCor('Cor', [entradaPadrao()])], filhos: SO_AZUL, viva: VIVA_77 }),
    );
    expect(casado.problemas).toEqual([]);

    for (const links of [null, [], [entrada({ variation_id: 0 })]]) {
      const r = montarTiers(
        args({ grupos: [grupoCor('Cor', links)], filhos: SO_AZUL, viva: VIVA_77 }),
      );
      expect(r.problemas, JSON.stringify(links)).toEqual([recusaPadraoViva('Cor', '77')]);
      expect(r.tiers).toEqual([]);
      expect(r.modelos).toEqual([]);
    }
  });

  it('⛔ QUASE (S2 nomeia o PAR): a 77 do grupo guardada para OUTRA categoria ou OUTRA conta não é deste par ⇒ S2 com a categoria DESTA publicação, nunca a da entrada alheia', () => {
    for (const estrangeira of [
      entradaPadrao({ category_id: 999999 }),
      entradaPadrao({ integracaoShopeeId: 'int-12' }),
    ]) {
      const r = montarTiers(
        args({ grupos: [grupoCor('Cor', [estrangeira])], filhos: SO_AZUL, viva: VIVA_77 }),
      );
      expect(r.problemas).toEqual([recusaPadraoViva('Cor', '77')]);
      const mensagem = r.problemas[0]?.mensagem ?? '';
      expect(mensagem).toContain(`categoria ${String(CATEGORIA)}`);
      expect(mensagem).not.toContain('999999');
    }
  });

  it('⛔ QUASE: o grupo implícito contra um tier vivo CUSTOM de outro nome recebe S1 — só renomear sai, e S1 não oferece a importação', () => {
    const r = montarTiers(
      args({ grupos: [grupoCor('Cores', null)], filhos: SO_AZUL, viva: VIVA_COR }),
    );
    expect(r.problemas).toEqual([recusaS1('Cores')]);
    const mensagem = r.problemas[0]?.mensagem ?? '';
    expect(mensagem).not.toContain('Importe');
    expect(mensagem).not.toContain('importe');
    expect(mensagem).toContain(
      'Ajuste o nome do grupo em Variações, ou o do tier no Seller Centre',
    );
  });

  it('⛔ QUASE: nenhum tier LEGÍVEL — só a árvore PADRÃO, sem tier_variation — recebe S1, nunca S2 com uma lista vazia de variações', () => {
    const viva: ArvoreVivaDoItem = {
      tier_variation: null,
      standardise_tier_variation: VIVA_77.standardise_tier_variation,
      model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
    };
    const r = montarTiers(args({ grupos: [grupoCor('Cor', null)], filhos: SO_AZUL, viva }));
    expect(r.problemas).toEqual([recusaS1('Cor')]);
    expect(r.problemas[0]?.mensagem).not.toContain('variação padronizada');
  });

  // #1911 P14b retitled this test (it was «… ⇒ os DOIS recebem S1 — renomear nunca
  // causa um par errado»): a rename toward the OTHER grupo's custom tier is still a
  // wrong pairing S1 can lead to, and a grupo already named like the standard tier
  // now gets S2 (the PAR below).
  it('⛔ QUASE (mistura): um tier CUSTOM e um PADRÃO 88 sobrando, dois grupos implícitos de OUTROS nomes ⇒ os DOIS recebem S1 — nenhum nome casa com o padrão que sobrou', () => {
    const { grupos, filhos } = doisGruposImplicitos('Grupo A inventado', 'Grupo B inventado');
    const r = montarTiers(
      args({
        grupos,
        filhos,
        viva: vivaDeDoisTiers([
          { nome: 'Estampa', variationId: 0 },
          { nome: 'Tamanho', variationId: 88 },
        ]),
      }),
    );
    expect(r.problemas).toEqual([recusaS1('Grupo A inventado'), recusaS1('Grupo B inventado')]);
  });

  /** The mix of the test above: a custom «Estampa» and a standard 88 «Tamanho», both unclaimed. */
  const VIVA_MISTA = vivaDeDoisTiers([
    { nome: 'Estampa', variationId: 0 },
    { nome: 'Tamanho', variationId: 88 },
  ]);

  it('⚠️ PAR (mistura, mesmo nome): o grupo Tamanho, já com o NOME do tier PADRÃO 88 que sobrou, recebe S2 nomeando 88 — renomear não o casa, só vincular; o grupo Cor recebe S1', () => {
    const { grupos, filhos } = doisGruposImplicitos('Cor', 'Tamanho');
    const r = montarTiers(args({ grupos, filhos, viva: VIVA_MISTA }));
    expect(r.problemas).toEqual([recusaS1('Cor'), recusaPadraoViva('Tamanho', '88')]);
    expect(r.tiers).toEqual([]);
    expect(r.modelos).toEqual([]);
  });

  it("⚠️ PAR (escopo da dobra): ' Tamanho ' (as PONTAS) é o nome do padrão 88 ⇒ S2, e a frase cita o grupo como está", () => {
    const { grupos, filhos } = doisGruposImplicitos('Cor', ' Tamanho ');
    const r = montarTiers(args({ grupos, filhos, viva: VIVA_MISTA }));
    expect(r.problemas).toEqual([recusaS1('Cor'), recusaPadraoViva(' Tamanho ', '88')]);
  });

  it.each([
    ['a CAIXA', 'tamanho', 'Tamanho'],
    ['o espaço de DENTRO', 'Tamanho  inventado', 'Tamanho inventado'],
  ])(
    '⛔ QUASE (escopo da dobra): %s não é o mesmo nome — %j contra o padrão 88 %j recebe S1, nunca S2',
    (_caso, nomeDoGrupo, nomeDoTier) => {
      const { grupos, filhos } = doisGruposImplicitos('Cor', nomeDoGrupo);
      const r = montarTiers(
        args({
          grupos,
          filhos,
          viva: vivaDeDoisTiers([
            { nome: 'Estampa', variationId: 0 },
            { nome: nomeDoTier, variationId: 88 },
          ]),
        }),
      );
      expect(r.problemas).toEqual([recusaS1('Cor'), recusaS1(nomeDoGrupo)]);
    },
  );

  it('⚠️ PAR: um tier CASADO não "sobra" — o custom Cor casa com o grupo Cor, o PADRÃO 88 sobra ⇒ só o Tamanho implícito é recusado, com S2 nomeando 88', () => {
    const { grupos, filhos } = doisGruposImplicitos('Cor', 'Tamanho');
    const r = montarTiers(
      args({
        grupos,
        filhos,
        viva: vivaDeDoisTiers([
          { nome: 'Cor', variationId: 0 },
          { nome: 'Tamanho', variationId: 88 },
        ]),
      }),
    );
    expect(r.problemas).toEqual([recusaPadraoViva('Tamanho', '88')]);
    expect(r.tiers.map((t) => t.grupoId)).toEqual(['g-a']);
  });

  it('⚠️ PAR: o tier CASADO não "sobra" nem para um grupo de OUTRO nome — com o custom Cor casado e só o PADRÃO 88 sobrando, o implícito «Grupo B inventado» recebe S2 nomeando 88, nunca S1', () => {
    // Since #1911 P14b a grupo named like the standard tier gets S2 even in a mix,
    // so the test above no longer tells "paired" from "unclaimed": this one does.
    const { grupos, filhos } = doisGruposImplicitos('Cor', 'Grupo B inventado');
    const r = montarTiers(
      args({
        grupos,
        filhos,
        viva: vivaDeDoisTiers([
          { nome: 'Cor', variationId: 0 },
          { nome: 'Tamanho', variationId: 88 },
        ]),
      }),
    );
    expect(r.problemas).toEqual([recusaPadraoViva('Grupo B inventado', '88')]);
    expect(r.tiers.map((t) => t.grupoId)).toEqual(['g-a']);
  });

  it('dois tiers PADRÃO sobrando ⇒ cada grupo implícito recebe S2 com «77 ou 88»; uma variação repetida é nomeada uma vez só', () => {
    const { grupos, filhos } = doisGruposImplicitos('Grupo A inventado', 'Grupo B inventado');
    const distintos = montarTiers(
      args({
        grupos,
        filhos,
        viva: vivaDeDoisTiers([
          { nome: 'Cor', variationId: 77 },
          { nome: 'Tamanho', variationId: 88 },
        ]),
      }),
    );
    expect(distintos.problemas).toEqual([
      recusaPadraoViva('Grupo A inventado', '77 ou 88'),
      recusaPadraoViva('Grupo B inventado', '77 ou 88'),
    ]);

    const repetidos = montarTiers(
      args({
        grupos,
        filhos,
        viva: vivaDeDoisTiers([
          { nome: 'Cor', variationId: 77 },
          { nome: 'Outra cor inventada', variationId: 77 },
        ]),
      }),
    );
    expect(repetidos.problemas).toEqual([
      recusaPadraoViva('Grupo A inventado', '77'),
      recusaPadraoViva('Grupo B inventado', '77'),
    ]);
  });

  it('⚠️ PAR (P2): quem escolhe S3 é a ENTRADA, não o tier vivo — a 88 armazenada contra o 77 vivo recebe S3; removida, o MESMO grupo recebe S2', () => {
    const comA88 = montarTiers(
      args({ grupos: [grupoCor('Cor', [ENTRADA_88])], filhos: SO_AZUL, viva: VIVA_77 }),
    );
    expect(comA88.problemas.map((p) => p.mensagem)).toEqual([TEXTO_PADRAO_NAO_CASA('Cor', 88)]);

    const semEla = montarTiers(
      args({ grupos: [grupoCor('Cor', null)], filhos: SO_AZUL, viva: VIVA_77 }),
    );
    expect(semEla.problemas.map((p) => p.mensagem)).toEqual([TEXTO_PADRAO_VIVO('Cor', '77')]);
  });

  // #1911 P14b, Q1 widened this test (it was «… — S1, S2, S3, a da variante e a do
  // vínculo ilegível (o regex TEXTO_DE_TERMINAL da web)»): the sixth sentence is the
  // append refused under a standard entry paired with a live custom tier.
  it('nenhuma frase de variacao-sem-vinculo aponta para o terminal — S1, S2, S3, a da variante, a do vínculo ilegível e a do anexo sob o padrão (Q1) (o regex TEXTO_DE_TERMINAL da web)', () => {
    // `apps/web/lib/shopee/anuncioProduto.test.ts`'s TEXTO_DE_TERMINAL: the web shows
    // these sentences verbatim and spells them by hand, so a CLI pointer added here
    // would pass every web test.
    const TEXTO_DE_TERMINAL = /(^|\s)--[a-z]|:anuncio|comando/i;
    const SO_VERDE = [
      filho({ produtoId: 'p-verde', variacoesUid: [varianteFakePath('g-cor', 'v-verde')] }),
    ];
    // Q1: the variante the child uses is named otherwise than the live custom
    // option «Azul», and ENTRADA_88 binds it to the standard option 9.
    const anexoSobPadrao = grupo({
      grupoId: 'g-cor',
      nome: 'Cor',
      variacoes: [variante('v-azul', 'Tom inventado'), verde],
      linksVariacoesShopee: [ENTRADA_88],
    });
    const resultados = [
      montarTiers(args({ grupos: [grupoCor('Cores', null)], filhos: SO_AZUL, viva: VIVA_COR })),
      montarTiers(args({ grupos: [grupoCor('Cor', null)], filhos: SO_AZUL, viva: VIVA_77 })),
      montarTiers(
        args({ grupos: [grupoCor('Cor', [ENTRADA_88])], filhos: SO_AZUL, viva: VIVA_77 }),
      ),
      montarTiers(args({ grupos: [grupoCor('Cor', [ENTRADA_88])], filhos: SO_VERDE, viva: null })),
      montarTiers(
        args({ grupos: [grupoCor('Cor', [entradaQuebrada()])], filhos: SO_AZUL, viva: VIVA_77 }),
      ),
      montarTiers(args({ grupos: [anexoSobPadrao], filhos: SO_AZUL, viva: VIVA_COR })),
    ];
    const daVariacao = resultados.flatMap((r) =>
      r.problemas.filter((p) => p.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo),
    );
    expect(
      daVariacao.filter((p) => p.campo === 'standardise_tier_variation').map((p) => p.mensagem),
    ).toEqual([
      TEXTO_NAO_CASA('Cores'),
      TEXTO_PADRAO_VIVO('Cor', '77'),
      TEXTO_PADRAO_NAO_CASA('Cor', 88),
      TEXTO_VARIANTE_SEM_OPCAO('Verde', 'Cor', 88),
      TEXTO_ILEGIVEL('Cor'),
      TEXTO_ANEXO_SOB_PADRAO('Tom inventado', 'Cor', 'Cor', 88),
    ]);
    for (const p of daVariacao) expect(p.mensagem).not.toMatch(TEXTO_DE_TERMINAL);
  });

  it('as saídas que cada frase nomeia: S1 nunca «Importe»; S2 nunca «nome do grupo», e o vínculo vem ANTES da importação', () => {
    const s1 = montarTiers(
      args({ grupos: [grupoCor('Cores', null)], filhos: SO_AZUL, viva: VIVA_COR }),
    ).problemas[0]?.mensagem;
    const s2 = montarTiers(
      args({ grupos: [grupoCor('Cor', null)], filhos: SO_AZUL, viva: VIVA_77 }),
    ).problemas[0]?.mensagem;
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1).not.toMatch(/[Ii]mporte/);
    expect(s2).not.toContain('nome do grupo');
    const vincule = s2!.indexOf(
      'Vincule o grupo a essa variação nessa categoria em Variações (aba Shopee)',
    );
    const importe = s2!.indexOf('ou importe o anúncio');
    expect(vincule).toBeGreaterThan(-1);
    expect(importe).toBeGreaterThan(vincule);
  });

  it('caracterização (S2, «ou importe»): com a variante de OUTRO nome que a opção viva, importar cria a variante shopee-5 no grupo, e a republicação passa a recusar a VARIANTE do filho — não mais S2', () => {
    const tom = variante('v-tom', 'Tom inventado');
    const viva: ArvoreVivaDoItem = {
      tier_variation: [
        shopeeTierVariationSchema.parse({
          name: 'Cor',
          option_list: [{ option: 'Opção inventada 1' }],
        }),
      ],
      standardise_tier_variation: [
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: 77,
          variation_name: 'Cor',
          variation_option_list: [
            { variation_option_id: 5, variation_option_name: 'Opção inventada 1' },
          ],
        }),
      ],
      model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'TM' })],
    };
    const filhos = [
      filho({ produtoId: 'p-tom', variacoesUid: [varianteFakePath('g-cor', 'v-tom')] }),
    ];
    const antes = montarTiers(
      args({
        grupos: [
          grupo({ grupoId: 'g-cor', nome: 'Cor', variacoes: [tom], linksVariacoesShopee: null }),
        ],
        filhos,
        viva,
      }),
    );
    expect(antes.problemas).toEqual([recusaPadraoViva('Cor', '77')]);

    const plano = reimportar(viva, [
      {
        id: 'g-cor',
        raw: {
          nome: 'Cor',
          tipo: TIPO_VARIACAO.cor,
          variacoes: [{ id: 'v-tom', nome: 'Tom inventado' }],
          variacoesIds: ['v-tom'],
          linksVariacoesShopee: null,
        },
      },
    ]);
    expect(plano.grupos.map((g) => [g.grupoId, g.varianteIds])).toEqual([['g-cor', ['shopee-5']]]);
    const patch = plano.grupos[0]?.patch;
    const variacoes = (patch?.variacoes ?? []) as readonly { id: string; nome: string }[];
    expect(variacoes.map((v) => [v.id, v.nome])).toEqual([
      ['v-tom', 'Tom inventado'],
      ['shopee-5', 'Opção inventada 1'],
    ]);

    const depois = montarTiers(
      args({
        grupos: [
          grupo({
            grupoId: 'g-cor',
            nome: 'Cor',
            variacoes: variacoes.map((v, i) => variante(v.id, v.nome, i + 1)),
            linksVariacoesShopee: patch?.linksVariacoesShopee as readonly unknown[],
          }),
        ],
        filhos,
        viva,
      }),
    );
    expect(depois.problemas.map((p) => p.mensagem)).toEqual([
      TEXTO_VARIANTE_SEM_OPCAO('Tom inventado', 'Cor', 77),
      'A variação p-tom não tem posição no grupo "Cor" e o modelo não pode ser colocado.',
    ]);
  });
});

describe('montarTiers — #1911 P14b: as frases novas cabem no teto de 500 caracteres (limitarMensagemProblema) com nomes longos e mantêm a saída', () => {
  /** 60 characters — twice Shopee's BR tier/option name band (30), for an ERP name. */
  const GRUPO_LONGO = 'Grupo inventado de nome longo '.padEnd(60, 'x');
  const VARIANTE_LONGA = 'Variante inventada de nome longo '.padEnd(60, 'y');
  /** Six-digit variation ids, the size of the committed BR fixtures'. */
  const VARIACAO_A = 101_054;
  const VARIACAO_B = 101_056;
  const MODELO = MODEL_ID + 7;

  function vivaPadrao(ids: readonly number[]): ArvoreVivaDoItem {
    return {
      tier_variation: ids.map((_, i) =>
        shopeeTierVariationSchema.parse({
          name: `Tier inventado ${String(i + 1)}`,
          option_list: [{ option: 'Única' }],
        }),
      ),
      standardise_tier_variation: ids.map((id, i) =>
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: id,
          variation_name: `Tier inventado ${String(i + 1)}`,
          variation_option_list: [{ variation_option_id: 1, variation_option_name: 'Única' }],
        }),
      ),
      model: [modeloVivo({ model_id: MODELO, tier_index: ids.map(() => 0), model_sku: 'U' })],
    };
  }

  const grupoLongo = (linksVariacoesShopee: readonly unknown[] | null, nome = GRUPO_LONGO) =>
    grupo({
      grupoId: 'g-longo',
      nome,
      variacoes: [variante('v-longa', VARIANTE_LONGA)],
      linksVariacoesShopee,
    });
  const outroGrupo = grupo({
    grupoId: 'g-outro',
    nome: 'Outro grupo inventado',
    ordem: 2,
    variacoes: [variante('v-outra', 'Única')],
    linksVariacoesShopee: null,
  });
  const umFilho = [
    filho({ produtoId: 'p-longo', variacoesUid: [varianteFakePath('g-longo', 'v-longa')] }),
  ];
  const doisFilhos = [
    filho({
      produtoId: 'p-longo-outro',
      variacoesUid: [
        varianteFakePath('g-longo', 'v-longa'),
        varianteFakePath('g-outro', 'v-outra'),
      ],
    }),
  ];

  function mensagemDoLongo(r: ReturnType<typeof montarTiers>): string {
    const mensagem = r.problemas[0]?.mensagem;
    expect(mensagem).toBeDefined();
    return mensagem!;
  }

  it('S1 com um grupo de 60 caracteres: inteira, terminando na saída', () => {
    const viva: ArvoreVivaDoItem = {
      tier_variation: [
        shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Única' }] }),
      ],
      standardise_tier_variation: null,
      model: [modeloVivo({ model_id: MODELO, tier_index: [0], model_sku: 'U' })],
    };
    const mensagem = mensagemDoLongo(
      montarTiers(args({ grupos: [grupoLongo(null)], filhos: umFilho, viva })),
    );
    expect(GRUPO_LONGO).toHaveLength(60);
    expect(mensagem).toBe(TEXTO_NAO_CASA(GRUPO_LONGO));
    expect(mensagem.length).toBeLessThanOrEqual(500);
    expect(mensagem.endsWith('para que os dois fiquem iguais.')).toBe(true);
  });

  it('S2 com um grupo de 60 caracteres e DUAS variações de seis dígitos: inteira, terminando na importação', () => {
    const mensagem = mensagemDoLongo(
      montarTiers(
        args({
          grupos: [grupoLongo(null), outroGrupo],
          filhos: doisFilhos,
          viva: vivaPadrao([VARIACAO_A, VARIACAO_B]),
        }),
      ),
    );
    expect(mensagem).toBe(
      TEXTO_PADRAO_VIVO(GRUPO_LONGO, `${String(VARIACAO_A)} ou ${String(VARIACAO_B)}`),
    );
    expect(mensagem.length).toBeLessThanOrEqual(500);
    expect(mensagem.endsWith('ou importe o anúncio.')).toBe(true);
  });

  it('S3 com um grupo de 60 caracteres: inteira, terminando em «ou remova-o.»', () => {
    const mensagem = mensagemDoLongo(
      montarTiers(
        args({
          grupos: [grupoLongo([entrada({ variation_id: VARIACAO_B })])],
          filhos: umFilho,
          viva: vivaPadrao([VARIACAO_A]),
        }),
      ),
    );
    expect(mensagem).toBe(TEXTO_PADRAO_NAO_CASA(GRUPO_LONGO, VARIACAO_B));
    expect(mensagem.length).toBeLessThanOrEqual(500);
    expect(mensagem.endsWith('ou remova-o.')).toBe(true);
  });

  it('a frase da VARIANTE com variante e grupo de 60 caracteres cada: inteira, com as três saídas', () => {
    const mensagem = mensagemDoLongo(
      montarTiers(
        args({
          grupos: [grupoLongo([entrada({ variation_id: VARIACAO_A })])],
          filhos: umFilho,
          viva: null,
        }),
      ),
    );
    expect(VARIANTE_LONGA).toHaveLength(60);
    expect(mensagem).toBe(TEXTO_VARIANTE_SEM_OPCAO(VARIANTE_LONGA, GRUPO_LONGO, VARIACAO_A));
    expect(mensagem.length).toBeLessThanOrEqual(500);
    expect(mensagem.endsWith('troque o vínculo por outra variação ou remova-o.')).toBe(true);
  });

  /* ---- #1911 P14b, Q1: the append refused under a standard entry ---------- */
  // The sentence's fixed text is 324 characters, so {v}, {g}, {tier} and {id}
  // share a budget of 176. {g} pairs with the live {tier} through the name fold,
  // so the two are (almost) the same string, and a LIVE tier name was authored
  // under Shopee's band (30 on BR).

  /** 30 characters — Shopee's BR tier name band, as much as a live custom tier carries. */
  const GRUPO_NA_BANDA = 'Grupo inventado na banda '.padEnd(30, 'z');

  /** A live CUSTOM tier named `nome`, one option «Única» the variante is NOT named like. */
  function vivaPersonalizada(nome: string): ArvoreVivaDoItem {
    return {
      tier_variation: [
        shopeeTierVariationSchema.parse({ name: nome, option_list: [{ option: 'Única' }] }),
      ],
      standardise_tier_variation: null,
      model: [modeloVivo({ model_id: MODELO, tier_index: [0], model_sku: 'U' })],
    };
  }

  /** The STANDARD entry VARIACAO_A binding the variante to its option 7. */
  const ENTRADA_A_DA_LONGA = entrada({
    variation_id: VARIACAO_A,
    variationOptions: [
      {
        shopee_option_id: 7,
        shopee_option_name: 'Opção inventada 1',
        arakene_variation_id: ['v-longa'],
      },
    ],
  });

  it('a frase do ANEXO sob o padrão (Q1) com variante de 60 caracteres, grupo e tier de 30 (a banda BR) e variação de seis dígitos: inteira, terminando em «outro grupo.»', () => {
    const mensagem = mensagemDoLongo(
      montarTiers(
        args({
          grupos: [grupoLongo([ENTRADA_A_DA_LONGA], GRUPO_NA_BANDA)],
          filhos: umFilho,
          viva: vivaPersonalizada(GRUPO_NA_BANDA),
        }),
      ),
    );
    expect(GRUPO_NA_BANDA).toHaveLength(30);
    expect(mensagem).toBe(
      TEXTO_ANEXO_SOB_PADRAO(VARIANTE_LONGA, GRUPO_NA_BANDA, GRUPO_NA_BANDA, VARIACAO_A),
    );
    expect(mensagem).toHaveLength(450);
    expect(mensagem.endsWith('ou mova as variações deste anúncio para outro grupo.')).toBe(true);
  });

  it('⛔ QUASE (o que o teto corta): grupo e tier de 60 caracteres (o DOBRO da banda), variante de 60 e seis dígitos somam 510 — a frase do anexo (Q1) vai a 500 com «…» e perde o fim de «outro grupo.»', () => {
    const mensagem = mensagemDoLongo(
      montarTiers(
        args({
          grupos: [grupoLongo([ENTRADA_A_DA_LONGA])],
          filhos: umFilho,
          viva: vivaPersonalizada(GRUPO_LONGO),
        }),
      ),
    );
    const inteira = TEXTO_ANEXO_SOB_PADRAO(VARIANTE_LONGA, GRUPO_LONGO, GRUPO_LONGO, VARIACAO_A);
    expect(inteira).toHaveLength(510);
    expect(mensagem).toBe(`${inteira.slice(0, 499)}…`);
    expect(mensagem).toContain('Renomeie a variante em Variações');
    expect(mensagem).not.toContain('outro grupo.');
  });

  it('⛔ QUASE (o que o teto corta): uma variante de 300 caracteres leva a frase do anexo (Q1) a 500 com «…» — e são as DUAS saídas que se perdem', () => {
    const enorme = 'V'.repeat(300);
    const mensagem = mensagemDoLongo(
      montarTiers(
        args({
          grupos: [
            grupo({
              grupoId: 'g-longo',
              nome: 'Cor',
              variacoes: [variante('v-longa', enorme)],
              linksVariacoesShopee: [ENTRADA_A_DA_LONGA],
            }),
          ],
          filhos: umFilho,
          viva: vivaPersonalizada('Cor'),
        }),
      ),
    );
    const inteira = TEXTO_ANEXO_SOB_PADRAO(enorme, 'Cor', 'Cor', VARIACAO_A);
    expect(mensagem).toHaveLength(500);
    expect(mensagem).toBe(`${inteira.slice(0, 499)}…`);
    expect(mensagem).not.toContain('Renomeie');
    expect(mensagem).not.toContain('outro grupo');
  });

  it('⛔ QUASE (o que o teto corta): um nome de grupo de 300 caracteres leva S2 a 500 com «…» — e é a SAÍDA que se perde', () => {
    const enorme = 'G'.repeat(300);
    const mensagem = mensagemDoLongo(
      montarTiers(
        args({
          grupos: [grupoLongo(null, enorme), outroGrupo],
          filhos: doisFilhos,
          viva: vivaPadrao([VARIACAO_A, VARIACAO_B]),
        }),
      ),
    );
    expect(mensagem).toHaveLength(500);
    expect(mensagem.endsWith('…')).toBe(true);
    expect(mensagem).not.toContain('ou importe o anúncio');
  });
});

/* -------------------------------------------------------------------------- */
/*  (2c-bis) #2043 — on an UPDATE, a STANDARD entry that pairs is the only    */
/*  one kept; an unpaired one is REFUSED too, with its own sentence           */
/* -------------------------------------------------------------------------- */

/** S3 (#2043), with the ending #1911 P14b decided (P14a Q5): swap the binding or remove it. */
const TEXTO_PADRAO_NAO_CASA = (grupoNome: string, variationId: number): string =>
  `O vínculo do grupo "${grupoNome}" usa a variação padronizada ${String(variationId)}, que nenhum tier do anúncio tem — republicar reescreveria as opções. Corrija o vínculo em Variações (aba Shopee): troque-o pela variação que o anúncio usa ou remova-o.`;

describe('montarTiers — #2043: na ATUALIZAÇÃO, um grupo de entrada PADRÃO que não casa com nenhum tier vivo também é RECUSADO', () => {
  const azul = variante('v-azul', 'Azul');
  const verde = variante('v-verde', 'Verde');
  const VERDE = MODEL_ID;
  const AZUL = MODEL_ID + 1;

  const DOIS_MODELOS = [
    modeloVivo({ model_id: VERDE, tier_index: [0], model_sku: 'VD' }),
    modeloVivo({ model_id: AZUL, tier_index: [1], model_sku: 'AZ' }),
  ];

  /**
   * The pairing fixture of (2c) above: live STANDARD tier 77 = [Verde(6) @0,
   * Azul(5) @1], a model on each.
   */
  function vivaPadrao77(modelos: readonly ShopeeModel[] = DOIS_MODELOS): ArvoreVivaDoItem {
    return arvorePadrao77(modelos);
  }

  function grupoCor(linksVariacoesShopee: readonly unknown[] | null): GrupoParaTier {
    return grupo({ grupoId: 'g-cor', nome: 'Cor', variacoes: [azul, verde], linksVariacoesShopee });
  }

  const tam = grupo({
    grupoId: 'g-tam',
    nome: 'Tamanho',
    ordem: 2,
    variacoes: [variante('v-p', 'P')],
    linksVariacoesShopee: null,
  });

  /** Only the Azul child is still published — the #2043 scenario. */
  const SO_AZUL: readonly FilhoParaPublicar[] = [
    filho({
      produtoId: 'p-azul',
      sku: 'AZ',
      linkDocId: 'l-azul',
      variacoesUid: [varianteFakePath('g-cor', 'v-azul')],
    }),
  ];

  const AZUL_P: readonly FilhoParaPublicar[] = [
    filho({
      produtoId: 'p-azul-p',
      variacoesUid: [varianteFakePath('g-cor', 'v-azul'), varianteFakePath('g-tam', 'v-p')],
    }),
  ];

  function recusaPadrao(grupoNome: string, variationId: number) {
    return {
      campo: 'standardise_tier_variation',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
      mensagem: TEXTO_PADRAO_NAO_CASA(grupoNome, variationId),
    };
  }

  it('⚠️ RECUSA: a entrada armazenada 88 contra o tier vivo 77, na MESMA profundidade e com modelos endereçáveis ⇒ variacao-sem-vinculo, tiers e modelos VAZIOS', () => {
    // Before #2043 the guard asked `variation_id === 0`: this grupo was rebuilt
    // in place as [Azul(9) @0], the Azul model followed its child there, and the
    // child-less Verde model kept [0] — which then named Azul.
    const r = montarTiers(
      args({ grupos: [grupoCor([ENTRADA_88])], filhos: SO_AZUL, viva: vivaPadrao77() }),
    );
    expect(r.problemas).toEqual([recusaPadrao('Cor', 88)]);
    expect(r.tiers).toEqual([]);
    expect(r.modelos).toEqual([]);
  });

  it('⚠️ PAR: a entrada armazenada 77 contra o MESMO tier vivo 77 casa — a lista viva é a base e o filho fica no índice 1', () => {
    const r = montarTiers(
      args({ grupos: [grupoCor([entradaPadrao()])], filhos: SO_AZUL, viva: vivaPadrao77() }),
    );
    expect(r.problemas).toEqual([]);
    expect(r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_id])).toEqual([
      ['v-verde', 6],
      ['v-azul', 5],
    ]);
    expect(r.modelos.map((m) => m.tier_index)).toEqual([[1]]);
  });

  it('⚠️ QUASE: a entrada 88 com mudança de profundidade (1→2) NÃO é recusada — é init_tier_variation, que recria todo modelo', () => {
    const viva = vivaPadrao77();
    const r = montarTiers(args({ grupos: [grupoCor([ENTRADA_88]), tam], filhos: AZUL_P, viva }));
    expect(r.problemas).toEqual([]);
    expect(r.tiers.map((t) => [t.grupoId, t.variation_id])).toEqual([
      ['g-cor', 88],
      ['g-tam', 0],
    ]);
    const plano = reconciliarModelos({
      montados: r.modelos,
      armazenados: [],
      viva,
      profundidadeNossa: r.tiers.length,
    });
    expect(plano).toMatchObject({ acao: 'init', mudouProfundidade: true });
  });

  it('⚠️ QUASE: a entrada 88 SEM modelo endereçável (nenhum, ou só model_id 0) NÃO é recusada — é init', () => {
    for (const modelos of [[], [modeloVivo({ model_id: 0, tier_index: [0] })]]) {
      const viva = vivaPadrao77(modelos);
      const r = montarTiers(args({ grupos: [grupoCor([ENTRADA_88])], filhos: SO_AZUL, viva }));
      expect(r.problemas, JSON.stringify(modelos)).toEqual([]);
      expect(r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_id])).toEqual([
        ['v-azul', 9],
      ]);
      const plano = reconciliarModelos({
        montados: r.modelos,
        armazenados: [],
        viva,
        profundidadeNossa: r.tiers.length,
      });
      expect(plano.acao).toBe('init');
    }
  });

  it('⚠️ QUASE (M1): no init, o grupo que CASA mantém as opções vivas e os nomes; o que NÃO casa é reescrito do ERP e as opções vivas saem', () => {
    const viva = vivaPadrao77();
    const opcoesDe = (r: ReturnType<typeof montarTiers>) =>
      r.tiers[0]!.opcoes.map((o) => [o.variation_option_id, o.variation_option_name]);

    const casado = montarTiers(
      args({ grupos: [grupoCor([entradaPadrao()]), tam], filhos: AZUL_P, viva }),
    );
    expect(casado.problemas).toEqual([]);
    expect(opcoesDe(casado)).toEqual([
      [6, 'Verde'],
      [5, 'Azul'],
    ]);

    const solto = montarTiers(
      args({
        grupos: [
          grupoCor([
            entradaPadrao({
              variation_id: 88,
              variationOptions: [
                {
                  shopee_option_id: 9,
                  shopee_option_name: 'Azul Turquesa',
                  arakene_variation_id: ['v-azul'],
                },
              ],
            }),
          ]),
          tam,
        ],
        filhos: AZUL_P,
        viva,
      }),
    );
    expect(solto.problemas).toEqual([]);
    expect(opcoesDe(solto)).toEqual([[9, 'Azul Turquesa']]);
    const plano = reconciliarModelos({
      montados: solto.modelos,
      armazenados: [],
      viva,
      profundidadeNossa: solto.tiers.length,
    });
    expect(plano).toMatchObject({ acao: 'init', mudouProfundidade: true });
  });

  // #1911 P14b retitled this test (it was «… a CUSTOM mantém o texto do Q2»): the
  // custom twin facing a live STANDARD tier no longer gets the Q2 sentence but S2.
  it('a frase PADRÃO (S3) nomeia a variação 88 e as duas saídas do vínculo em Variações — trocar ou remover, nunca «Importe» (a importação não sobrescreve um variation_id não-zero); a gêmea CUSTOM recebe S2 (vincular, ou importar)', () => {
    const padrao = montarTiers(
      args({ grupos: [grupoCor([ENTRADA_88])], filhos: SO_AZUL, viva: vivaPadrao77() }),
    );
    const mensagem = padrao.problemas[0]?.mensagem ?? '';
    expect(mensagem).toContain('variação padronizada 88');
    expect(mensagem).toContain('Variações (aba Shopee)');
    expect(mensagem).toContain('troque-o pela variação que o anúncio usa');
    expect(mensagem).toContain('ou remova-o');
    expect(mensagem).not.toContain('Importe');
    expect(mensagem).not.toContain('importe');

    // ⛔ pair: a stored CUSTOM entry that does not pair, facing a live STANDARD
    // tier, gets S2 — bind it, or import.
    const custom = montarTiers(
      args({
        grupos: [grupoCor([entrada({ variation_id: 0 })])],
        filhos: SO_AZUL,
        viva: vivaPadrao77(),
      }),
    );
    expect(custom.problemas.map((p) => p.mensagem)).toEqual([TEXTO_PADRAO_VIVO('Cor', '77')]);
  });

  it('em DOIS níveis, a Cor padrão que não casa (seria ANEXADA por último, trocando os eixos) é recusada; o Tamanho custom casado não', () => {
    const viva: ArvoreVivaDoItem = {
      tier_variation: [
        shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
        shopeeTierVariationSchema.parse({ name: 'Tamanho', option_list: [{ option: 'P' }] }),
      ],
      standardise_tier_variation: [
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: 77,
          variation_name: 'Cor',
          variation_option_list: [{ variation_option_id: 5, variation_option_name: 'Azul' }],
        }),
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: 0,
          variation_name: 'Tamanho',
          variation_option_list: [{ variation_option_id: 0, variation_option_name: 'P' }],
        }),
      ],
      model: [modeloVivo({ model_id: AZUL, tier_index: [0, 0], model_sku: 'AZ-P' })],
    };
    const r = montarTiers(args({ grupos: [grupoCor([ENTRADA_88]), tam], filhos: AZUL_P, viva }));
    expect(r.problemas).toEqual([recusaPadrao('Cor', 88)]);
    expect(r.tiers.map((t) => t.grupoId)).toEqual(['g-tam']);
    expect(r.modelos).toEqual([]);
  });

  it('um CREATE (sem árvore viva) com a entrada 88 nunca passa pela guarda', () => {
    for (const viva of [null, undefined]) {
      const r = montarTiers(args({ grupos: [grupoCor([ENTRADA_88])], filhos: SO_AZUL, viva }));
      expect(r.problemas).toEqual([]);
      expect(r.tiers.map((t) => t.variation_id)).toEqual([88]);
    }
  });

  // #1911 P14b retitled this test (it was «… a fusão mantém o 88 e só anexa as
  // linhas vivas …»): since #2108 point 8 the merge appends nothing beside
  // another variation.
  it('⚠️ QUASE: reimportar NÃO tira da recusa a entrada 88 — a fusão mantém o 88 e as linhas dele, e a recusa é a mesma', () => {
    const viva = vivaPadrao77();
    const plano = reimportar(viva, [docDoGrupoCor('g-cor', 'Cor', [ENTRADA_88])]);
    const links = plano.grupos[0]?.patch?.linksVariacoesShopee as readonly unknown[];
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ variation_id: 88 });
    const r = montarTiers(args({ grupos: [grupoCor(links)], filhos: SO_AZUL, viva }));
    expect(r.problemas).toEqual([recusaPadrao('Cor', 88)]);
  });

  /* ---- #1911 P14b (#2108 point 8): the import no longer carries 77's rows  */
  /* into the 88 entry, so the publisher never sends them under 88          */

  describe('#1911 P14b (#2108 ponto 8): reimportado de um anúncio 77, o grupo da entrada 88 não ganha as linhas de 77 — e a publicação nunca as manda sob 88', () => {
    /** Both children: Verde is the one the 88 entry binds no option to. */
    const AZUL_P_E_VERDE_P: readonly FilhoParaPublicar[] = [
      filho({
        produtoId: 'p-azul-p',
        variacoesUid: [varianteFakePath('g-cor', 'v-azul'), varianteFakePath('g-tam', 'v-p')],
      }),
      filho({
        produtoId: 'p-verde-p',
        variacoesUid: [varianteFakePath('g-cor', 'v-verde'), varianteFakePath('g-tam', 'v-p')],
      }),
    ];

    const idsDeOpcao = (r: ReturnType<typeof montarTiers>) =>
      r.tiers.flatMap((t) => t.opcoes.map((o) => o.variation_option_id));

    /** The 88 entry as the REAL import over the 77 listing leaves it. */
    function linksDepoisDaImportacao77(armazenada: unknown): readonly unknown[] {
      const plano = reimportar(vivaPadrao77(), [docDoGrupoCor('g-cor', 'Cor', [armazenada])]);
      const patch = plano.grupos[0]?.patch;
      return (patch?.linksVariacoesShopee as readonly unknown[] | undefined) ?? [armazenada];
    }

    it('⛔ QUASE (h): na mudança de profundidade (init), Verde é RECUSADA com a frase da variante — nenhuma opção 6 (de 77) vai sob 88', () => {
      const links = linksDepoisDaImportacao77(ENTRADA_88);
      const r = montarTiers(
        args({ grupos: [grupoCor(links), tam], filhos: AZUL_P_E_VERDE_P, viva: vivaPadrao77() }),
      );
      expect(r.problemas).toEqual([
        {
          campo: 'standardise_tier_variation',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          mensagem: TEXTO_VARIANTE_SEM_OPCAO('Verde', 'Cor', 88),
        },
        {
          campo: 'model',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          mensagem:
            'A variação p-verde-p não tem posição no grupo "Cor" e o modelo não pode ser colocado.',
        },
      ]);
      expect(idsDeOpcao(r)).not.toContain(6);
      expect(idsDeOpcao(r)).not.toContain(5);
    });

    it('⛔ QUASE (i): o mesmo grupo numa CRIAÇÃO (sem árvore viva) — Verde é recusada, nenhuma opção de 77 é autorada', () => {
      const links = linksDepoisDaImportacao77(ENTRADA_88);
      for (const viva of [null, undefined]) {
        const r = montarTiers(
          args({ grupos: [grupoCor(links), tam], filhos: AZUL_P_E_VERDE_P, viva }),
        );
        expect(r.problemas[0]?.mensagem).toBe(TEXTO_VARIANTE_SEM_OPCAO('Verde', 'Cor', 88));
        expect(idsDeOpcao(r)).not.toContain(6);
        expect(idsDeOpcao(r)).not.toContain(5);
      }
    });

    it('⚠️ PAR (j): Verde ligada a uma opção DE 88 (11) ⇒ o init leva as opções [9, 11] e nada é recusado', () => {
      const comVerde = {
        ...(entradaPadrao({
          variation_id: 88,
          variationOptions: [
            { shopee_option_id: 9, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
            {
              shopee_option_id: 11,
              shopee_option_name: 'Verde',
              arakene_variation_id: ['v-verde'],
            },
          ],
        }) as object),
        name: 'Camisetas',
      };
      const links = linksDepoisDaImportacao77(comVerde);
      const viva = vivaPadrao77();
      const r = montarTiers(
        args({ grupos: [grupoCor(links), tam], filhos: AZUL_P_E_VERDE_P, viva }),
      );
      expect(r.problemas).toEqual([]);
      expect(r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_id])).toEqual([
        ['v-azul', 9],
        ['v-verde', 11],
      ]);
      const plano = reconciliarModelos({
        montados: r.modelos,
        armazenados: [],
        viva,
        profundidadeNossa: r.tiers.length,
      });
      expect(plano).toMatchObject({ acao: 'init', mudouProfundidade: true });
    });

    it('⛔ QUASE (k): o anúncio cujo tier É 88 [Azul(9)] — republicar não anexa (88, 6): Verde é recusada com a frase da variante', () => {
      const links = linksDepoisDaImportacao77(ENTRADA_88);
      const viva88: ArvoreVivaDoItem = {
        tier_variation: [
          shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
        ],
        standardise_tier_variation: [
          shopeeStandardiseTierVariationSchema.parse({
            variation_id: 88,
            variation_name: 'Cor',
            variation_option_list: [{ variation_option_id: 9, variation_option_name: 'Azul' }],
          }),
        ],
        model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
      };
      const r = montarTiers(
        args({
          grupos: [grupoCor(links)],
          filhos: [
            SO_AZUL[0]!,
            filho({ produtoId: 'p-verde', variacoesUid: [varianteFakePath('g-cor', 'v-verde')] }),
          ],
          viva: viva88,
        }),
      );
      expect(r.problemas.map((p) => p.mensagem)).toEqual([
        TEXTO_VARIANTE_SEM_OPCAO('Verde', 'Cor', 88),
        'A variação p-verde não tem posição no grupo "Cor" e o modelo não pode ser colocado.',
      ]);
      expect(r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_id])).toEqual([
        ['v-azul', 9],
      ]);
    });

    it('⚠️ PAR (as saídas da frase da variante): no anúncio cujo tier É 88, só VINCULAR a variante passa o plano e a perna de modelos; trocar o vínculo por 77 ou removê-lo passa o plano (sem árvore viva) e é recusado depois, com S3 ou S2', () => {
      const viva88: ArvoreVivaDoItem = {
        tier_variation: [
          shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
        ],
        standardise_tier_variation: [
          shopeeStandardiseTierVariationSchema.parse({
            variation_id: 88,
            variation_name: 'Cor',
            variation_option_list: [{ variation_option_id: 9, variation_option_name: 'Azul' }],
          }),
        ],
        model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
      };
      const filhos = [
        SO_AZUL[0]!,
        filho({ produtoId: 'p-verde', variacoesUid: [varianteFakePath('g-cor', 'v-verde')] }),
      ];
      const plano = (links: readonly unknown[] | null) =>
        montarTiers(args({ grupos: [grupoCor(links)], filhos, viva: null })).problemas;
      const pernaDeModelos = (links: readonly unknown[] | null) =>
        montarTiers(args({ grupos: [grupoCor(links)], filhos, viva: viva88 }));

      // PAR: Verde bound to an option OF 88 (11) — the plan and the leg both pass.
      const vinculada = {
        ...(entradaPadrao({
          variation_id: 88,
          variationOptions: [
            { shopee_option_id: 9, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
            {
              shopee_option_id: 11,
              shopee_option_name: 'Verde',
              arakene_variation_id: ['v-verde'],
            },
          ],
        }) as object),
        name: 'Camisetas',
      };
      expect(plano([vinculada])).toEqual([]);
      const ok = pernaDeModelos([vinculada]);
      expect(ok.problemas).toEqual([]);
      expect(ok.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_id])).toEqual([
        ['v-azul', 9],
        ['v-verde', 11],
      ]);

      // ⛔ QUASE: SWAPPED for 77 (both variantes bound) — the plan passes, the leg says S3.
      expect(plano([entradaPadrao()])).toEqual([]);
      expect(pernaDeModelos([entradaPadrao()]).problemas.map((p) => p.mensagem)).toEqual([
        TEXTO_PADRAO_NAO_CASA('Cor', 77),
      ]);

      // ⛔ QUASE: REMOVED (implicit custom) — the plan passes, the leg says S2 naming 88.
      for (const removida of [null, []]) {
        expect(plano(removida)).toEqual([]);
        expect(pernaDeModelos(removida).problemas.map((p) => p.mensagem)).toEqual([
          TEXTO_PADRAO_VIVO('Cor', '88'),
        ]);
      }
    });
  });

  it('⚠️ RECUSA: a entrada armazenada 88 contra um tier vivo CUSTOM de OUTRO nome, em um nível, sem outro grupo com esse nome ⇒ variacao-sem-vinculo', () => {
    const viva: ArvoreVivaDoItem = {
      tier_variation: [
        shopeeTierVariationSchema.parse({ name: 'Estampa', option_list: [{ option: 'Azul' }] }),
      ],
      standardise_tier_variation: null,
      model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
    };
    const r = montarTiers(args({ grupos: [grupoCor([ENTRADA_88])], filhos: SO_AZUL, viva }));
    expect(r.problemas).toEqual([recusaPadrao('Cor', 88)]);
    expect(r.tiers).toEqual([]);
    expect(r.modelos).toEqual([]);
  });

  it('caracterização: a entrada armazenada 88 contra um tier vivo CUSTOM de MESMO nome casa pelo nome e vai sob 88 sobre opções de id 0 — a aceitação pela Shopee NÃO foi medida (README)', () => {
    const viva = arvore(
      ['Azul'],
      [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
    );
    const r = montarTiers(args({ grupos: [grupoCor([ENTRADA_88])], filhos: SO_AZUL, viva }));
    expect(r.problemas).toEqual([]);
    expect(r.tiers.map((t) => [t.variation_id, t.variation_name])).toEqual([[88, null]]);
    expect(r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_id])).toEqual([
      ['v-azul', 0],
    ]);
    expect(r.modelos.map((m) => m.tier_index)).toEqual([[0]]);
  });

  // #1911 P14b, Q1 (Lucas, 2026-11-11) FLIPPED and retitled this test. It was
  // «⚠️ RESÍDUO (#1911 P14b, aberto para Lucas): a entrada 88 casa pelo NOME com o
  // tier vivo CUSTOM — a variante de nome IGUAL à opção viva fica na posição; a de
  // nome DIFERENTE (o degrau 3 da importação, ou renomeada no ERP) é ANEXADA sob o id
  // 11 da linha padrão, e o modelo do filho vai para ela» — the residue it pinned is
  // now refused with the sentence Lucas signed off.
  it('⚠️ RECUSA (#1911 P14b, Q1): a entrada 88 casa pelo NOME com o tier vivo CUSTOM — a variante de nome IGUAL à opção viva fica na posição; a de nome DIFERENTE (o degrau 3 da importação, ou renomeada no ERP) é RECUSADA com a frase decidida, nada é anexado sob o id 11 e nenhum modelo muda de posição', () => {
    const TOM = AZUL + 1;
    const viva = arvore(
      ['Azul', 'Tom inventada'],
      [
        modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' }),
        modeloVivo({ model_id: TOM, tier_index: [1], model_sku: 'TOM' }),
      ],
    );
    const entrada88 = {
      ...(entradaPadrao({
        variation_id: 88,
        variationOptions: [
          { shopee_option_id: 9, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
          {
            shopee_option_id: 11,
            shopee_option_name: 'Tom inventado',
            arakene_variation_id: ['v-tom'],
          },
        ],
      }) as object),
      name: 'Camisetas',
    };
    const publicar = (nomeDaVariante: string) => {
      const montagem = montarTiers(
        args({
          grupos: [
            grupo({
              grupoId: 'g-cor',
              nome: 'Cor',
              variacoes: [azul, variante('v-tom', nomeDaVariante)],
              linksVariacoesShopee: [entrada88],
            }),
          ],
          filhos: [
            SO_AZUL[0]!,
            filho({
              produtoId: 'p-tom',
              sku: 'TOM',
              linkDocId: 'l-tom',
              variacoesUid: [varianteFakePath('g-cor', 'v-tom')],
            }),
          ],
          viva,
        }),
      );
      const plano = reconciliarModelos({
        montados: montagem.modelos,
        armazenados: [
          {
            produtoId: 'p-azul',
            linkDocId: 'l-azul',
            modelId: AZUL,
            modelSku: 'AZ',
            tierIndex: [0],
          },
          { produtoId: 'p-tom', linkDocId: 'l-tom', modelId: TOM, modelSku: 'TOM', tierIndex: [1] },
        ],
        viva,
        profundidadeNossa: montagem.tiers.length,
      });
      return {
        problemas: montagem.problemas,
        tiers: montagem.tiers.map((t) => [t.variation_id, t.variation_name]),
        opcoes: montagem.tiers[0]?.opcoes.map((o) => [
          o.varianteId,
          o.variation_option_id,
          o.variation_option_name,
        ]),
        modelList: plano.modelList,
      };
    };

    // PAR: the variante named EXACTLY like its live option keeps the position.
    expect(publicar('Tom inventada')).toEqual({
      problemas: [],
      tiers: [[88, null]],
      opcoes: [
        ['v-azul', 0, 'Azul'],
        ['v-tom', 0, 'Tom inventada'],
      ],
      modelList: [
        { model_id: AZUL, tier_index: [0] },
        { model_id: TOM, tier_index: [1] },
      ],
    });
    // ⚠️ REFUSED (Q1): named otherwise (here the import's rung-3 gender vowel), it
    // used to be appended under the standard row's id 11 inside the custom tier, its
    // model moving to [2]. Now nothing is appended for v-tom: the live option keeps
    // its index with no variante, the TOM model stays at [1] in this partial reading
    // (the publish is blocked, so nothing is sent), and the child cannot be placed.
    expect(publicar('Tom inventado')).toEqual({
      problemas: [
        {
          campo: 'standardise_tier_variation',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          mensagem:
            'A variante "Tom inventado" do grupo "Cor" não casa pelo nome com nenhuma opção do tier personalizado "Cor" do anúncio, e o vínculo do grupo usa a variação padronizada 88 — republicar acrescentaria uma opção e moveria o modelo. Renomeie a variante em Variações para o nome da opção do anúncio, ou mova as variações deste anúncio para outro grupo.',
        },
        {
          campo: 'model',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          mensagem:
            'A variação p-tom não tem posição no grupo "Cor" e o modelo não pode ser colocado.',
        },
      ],
      tiers: [[88, null]],
      opcoes: [
        ['v-azul', 0, 'Azul'],
        [null, 0, 'Tom inventada'],
      ],
      modelList: [
        { model_id: AZUL, tier_index: [0] },
        { model_id: TOM, tier_index: [1] },
      ],
    });
  });

  /* ---- #1911 P14b, Q1: the scope of the append refusal ------------------- */

  describe('#1911 P14b (Q1): a entrada PADRÃO casada pelo NOME com o tier vivo CUSTOM — todo ANEXO no leg que reescreve no lugar é recusado, e só ele', () => {
    const TOM = AZUL + 1;
    const OUTRO = AZUL + 2;

    /** Live CUSTOM tier 'Cor' = [Azul @0, Tom inventada @1], a model on each. */
    const VIVA_AZUL_TOM = arvore(
      ['Azul', 'Tom inventada'],
      [
        modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' }),
        modeloVivo({ model_id: TOM, tier_index: [1], model_sku: 'TOM' }),
      ],
    );

    /** The STANDARD entry 88: Azul → 9 and v-tom → the given row (11 «Tom inventado» by default). */
    function entrada88(
      linhaDoTom: OpcaoDeEntrada = {
        shopee_option_id: 11,
        shopee_option_name: 'Tom inventado',
        arakene_variation_id: ['v-tom'],
      },
    ): unknown {
      return {
        ...(entradaPadrao({
          variation_id: 88,
          variationOptions: [
            { shopee_option_id: 9, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
            linhaDoTom,
          ],
        }) as object),
        name: 'Camisetas',
      };
    }

    function grupoComTom(
      nomeDoTom: string,
      links: readonly unknown[] | null = [entrada88()],
      nomeDoGrupo = 'Cor',
    ): GrupoParaTier {
      return grupo({
        grupoId: 'g-cor',
        nome: nomeDoGrupo,
        variacoes: [azul, variante('v-tom', nomeDoTom)],
        linksVariacoesShopee: links,
      });
    }

    const P_TOM = filho({
      produtoId: 'p-tom',
      sku: 'TOM',
      linkDocId: 'l-tom',
      variacoesUid: [varianteFakePath('g-cor', 'v-tom')],
    });
    const AZUL_E_TOM: readonly FilhoParaPublicar[] = [SO_AZUL[0]!, P_TOM];

    const opcoesDe = (r: ReturnType<typeof montarTiers>) =>
      r.tiers[0]?.opcoes.map((o) => [o.varianteId, o.variation_option_id, o.variation_option_name]);

    const naoTemPosicao = (produtoId: string, grupoNome = 'Cor') => ({
      campo: 'model',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
      mensagem: `A variação ${produtoId} não tem posição no grupo "${grupoNome}" e o modelo não pode ser colocado.`,
    });

    const recusaDoAnexo = (varianteNome: string, grupoNome = 'Cor', tierNome = 'Cor') => ({
      campo: 'standardise_tier_variation',
      motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
      mensagem: TEXTO_ANEXO_SOB_PADRAO(varianteNome, grupoNome, tierNome, 88),
    });

    it('⚠️ PAR / ⛔ QUASE (os dois caminhos do resíduo): o degrau 3 da importação (vogal de gênero, troca espaço/hífen) e a variante RENOMEADA no ERP — com a linha ainda «Tom inventado» — são RECUSADAS e {v} é o nome da VARIANTE, nunca o da linha', () => {
      for (const nome of ['Tom inventado', 'Tom-inventada', 'Tom renomeado no ERP']) {
        const r = montarTiers(
          args({ grupos: [grupoComTom(nome)], filhos: AZUL_E_TOM, viva: VIVA_AZUL_TOM }),
        );
        expect(r.problemas, nome).toEqual([recusaDoAnexo(nome), naoTemPosicao('p-tom')]);
        expect(opcoesDe(r), nome).toEqual([
          ['v-azul', 0, 'Azul'],
          [null, 0, 'Tom inventada'],
        ]);
      }
    });

    it('⚠️ PAR (a forma de id 0): uma linha {0, «Tom antigo inventado»} que NÃO casa com nenhuma opção viva também seria anexada (id 0) e moveria o modelo ⇒ RECUSADA; QUASE: a linha {0, «Tom inventada»} casa com a opção viva e a variante FICA na posição, sem recusa', () => {
      const naoCasa = montarTiers(
        args({
          grupos: [
            grupoComTom('Tom inventado', [
              entrada88({
                shopee_option_id: 0,
                shopee_option_name: 'Tom antigo inventado',
                arakene_variation_id: ['v-tom'],
              }),
            ]),
          ],
          filhos: AZUL_E_TOM,
          viva: VIVA_AZUL_TOM,
        }),
      );
      expect(naoCasa.problemas).toEqual([recusaDoAnexo('Tom inventado'), naoTemPosicao('p-tom')]);
      expect(opcoesDe(naoCasa)).toEqual([
        ['v-azul', 0, 'Azul'],
        [null, 0, 'Tom inventada'],
      ]);

      const casa = montarTiers(
        args({
          grupos: [
            grupoComTom('Tom inventado', [
              entrada88({
                shopee_option_id: 0,
                shopee_option_name: 'Tom inventada',
                arakene_variation_id: ['v-tom'],
              }),
            ]),
          ],
          filhos: AZUL_E_TOM,
          viva: VIVA_AZUL_TOM,
        }),
      );
      expect(casa.problemas).toEqual([]);
      expect(opcoesDe(casa)).toEqual([
        ['v-azul', 0, 'Azul'],
        ['v-tom', 0, 'Tom inventada'],
      ]);
      expect(casa.modelos.map((m) => [m.produtoId, m.tier_index])).toEqual([
        ['p-azul', [0]],
        ['p-tom', [1]],
      ]);
    });

    it('⚠️ PAR (escopo da dobra): « Tom inventada » (as PONTAS) casa com a opção viva pela dobra e NÃO é recusada; ⛔ QUASE: «tom inventada» (a CAIXA) não casa e é recusada', () => {
      const pontas = montarTiers(
        args({
          grupos: [grupoComTom(' Tom inventada ')],
          filhos: AZUL_E_TOM,
          viva: VIVA_AZUL_TOM,
        }),
      );
      expect(pontas.problemas).toEqual([]);
      expect(opcoesDe(pontas)).toEqual([
        ['v-azul', 0, 'Azul'],
        ['v-tom', 0, 'Tom inventada'],
      ]);

      const caixa = montarTiers(
        args({ grupos: [grupoComTom('tom inventada')], filhos: AZUL_E_TOM, viva: VIVA_AZUL_TOM }),
      );
      expect(caixa.problemas).toEqual([recusaDoAnexo('tom inventada'), naoTemPosicao('p-tom')]);
    });

    it('⚠️ PAR ({g} e {tier}): o grupo « Cor » casa com o tier vivo «Cor» pela dobra — a frase cita o grupo COMO ESTÁ e o tier como LIDO do anúncio', () => {
      const r = montarTiers(
        args({
          grupos: [grupoComTom('Tom inventado', [entrada88()], ' Cor ')],
          filhos: AZUL_E_TOM,
          viva: VIVA_AZUL_TOM,
        }),
      );
      expect(r.problemas).toEqual([
        recusaDoAnexo('Tom inventado', ' Cor ', 'Cor'),
        naoTemPosicao('p-tom', ' Cor '),
      ]);
    });

    it('⛔ QUASE (§5-7 intacta): uma variante usada SEM linha na entrada 88 continua com a frase da VARIANTE, nunca a do anexo', () => {
      const semLinha = {
        ...(entradaPadrao({
          variation_id: 88,
          variationOptions: [
            { shopee_option_id: 9, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
          ],
        }) as object),
        name: 'Camisetas',
      };
      const r = montarTiers(
        args({
          grupos: [grupoComTom('Tom inventado', [semLinha])],
          filhos: AZUL_E_TOM,
          viva: VIVA_AZUL_TOM,
        }),
      );
      expect(r.problemas).toEqual([
        {
          campo: 'standardise_tier_variation',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          mensagem: TEXTO_VARIANTE_SEM_OPCAO('Tom inventado', 'Cor', 88),
        },
        naoTemPosicao('p-tom'),
      ]);
    });

    it('⛔ QUASE (só as USADAS): a variante «Tom inventado» com a linha 11 mas sem filho nesta publicação não é recusada — a opção viva fica no índice dela, ocupada pelo modelo sem filho', () => {
      const r = montarTiers(
        args({ grupos: [grupoComTom('Tom inventado')], filhos: SO_AZUL, viva: VIVA_AZUL_TOM }),
      );
      expect(r.problemas).toEqual([]);
      expect(opcoesDe(r)).toEqual([
        ['v-azul', 0, 'Azul'],
        [null, 0, 'Tom inventada'],
      ]);
      expect(r.tiers[0]!.opcoes.map((o) => o.ocupadaPorModeloSemFilho)).toEqual([false, true]);
    });

    it('⚠️ DUAS variantes recusadas ⇒ DUAS frases, na ordem do GRUPO (não na dos filhos), e depois a de cada filho sem posição', () => {
      const viva = arvore(
        ['Azul', 'Tom inventada', 'Outro tom inventada'],
        [
          modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' }),
          modeloVivo({ model_id: TOM, tier_index: [1], model_sku: 'TOM' }),
          modeloVivo({ model_id: OUTRO, tier_index: [2], model_sku: 'OUT' }),
        ],
      );
      const links = [
        {
          ...(entradaPadrao({
            variation_id: 88,
            variationOptions: [
              { shopee_option_id: 9, shopee_option_name: 'Azul', arakene_variation_id: ['v-azul'] },
              {
                shopee_option_id: 11,
                shopee_option_name: 'Tom inventado',
                arakene_variation_id: ['v-tom'],
              },
              {
                shopee_option_id: 12,
                shopee_option_name: 'Outro tom inventado',
                arakene_variation_id: ['v-outro'],
              },
            ],
          }) as object),
          name: 'Camisetas',
        },
      ];
      const r = montarTiers(
        args({
          grupos: [
            grupo({
              grupoId: 'g-cor',
              nome: 'Cor',
              variacoes: [
                azul,
                variante('v-outro', 'Outro tom inventado'),
                variante('v-tom', 'Tom inventado'),
              ],
              linksVariacoesShopee: links,
            }),
          ],
          filhos: [
            SO_AZUL[0]!,
            P_TOM,
            filho({ produtoId: 'p-outro', variacoesUid: [varianteFakePath('g-cor', 'v-outro')] }),
          ],
          viva,
        }),
      );
      expect(r.problemas).toEqual([
        recusaDoAnexo('Outro tom inventado'),
        recusaDoAnexo('Tom inventado'),
        naoTemPosicao('p-tom'),
        naoTemPosicao('p-outro'),
      ]);
    });

    it('⛔ QUASE (tier vivo PADRÃO): o tier vivo 88 com a entrada 88 e um filho novo ligado à opção 12 ⇒ ANEXADO como hoje, sem recusa', () => {
      const viva88: ArvoreVivaDoItem = {
        tier_variation: [
          shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
        ],
        standardise_tier_variation: [
          shopeeStandardiseTierVariationSchema.parse({
            variation_id: 88,
            variation_name: 'Cor',
            variation_option_list: [{ variation_option_id: 9, variation_option_name: 'Azul' }],
          }),
        ],
        model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
      };
      const r = montarTiers(
        args({
          grupos: [
            grupoComTom('Tom inventado', [
              entrada88({
                shopee_option_id: 12,
                shopee_option_name: 'Tom inventado',
                arakene_variation_id: ['v-tom'],
              }),
            ]),
          ],
          filhos: AZUL_E_TOM,
          viva: viva88,
        }),
      );
      expect(r.problemas).toEqual([]);
      expect(opcoesDe(r)).toEqual([
        ['v-azul', 9, 'Azul'],
        ['v-tom', 12, 'Tom inventado'],
      ]);
      expect(r.modelos.map((m) => [m.produtoId, m.tier_index])).toEqual([
        ['p-azul', [0]],
        ['p-tom', [1]],
      ]);
    });

    it('⛔ QUASE (entrada CUSTOM): o grupo de entrada 0 armazenada, ou sem entrada, casado com o tier vivo custom ⇒ a variante nova é ANEXADA como hoje (id 0, o nome dela), sem recusa', () => {
      for (const links of [[entrada({ variation_id: 0 })], null]) {
        const r = montarTiers(
          args({
            grupos: [grupoComTom('Verde inventado', links)],
            filhos: AZUL_E_TOM,
            viva: arvore(
              ['Azul'],
              [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
            ),
          }),
        );
        expect(r.problemas, JSON.stringify(links)).toEqual([]);
        expect(opcoesDe(r)).toEqual([
          ['v-azul', 0, 'Azul'],
          ['v-tom', 0, 'Verde inventado'],
        ]);
      }
    });

    it('⛔ QUASE (o braço init): na mudança de profundidade, ou sem modelo endereçável, a guarda do anexo NÃO dispara — init_tier_variation recria todo modelo, nada "se move"', () => {
      const tam = grupo({
        grupoId: 'g-tam',
        nome: 'Tamanho',
        ordem: 2,
        variacoes: [variante('v-p', 'P')],
        linksVariacoesShopee: null,
      });
      const comTamanho = montarTiers(
        args({
          grupos: [grupoComTom('Tom inventado'), tam],
          filhos: [
            filho({
              produtoId: 'p-tom-p',
              variacoesUid: [varianteFakePath('g-cor', 'v-tom'), varianteFakePath('g-tam', 'v-p')],
            }),
          ],
          viva: VIVA_AZUL_TOM,
        }),
      );
      expect(comTamanho.problemas).toEqual([]);
      expect(opcoesDe(comTamanho)).toContainEqual(['v-tom', 11, 'Tom inventado']);
      expect(
        reconciliarModelos({
          montados: comTamanho.modelos,
          armazenados: [],
          viva: VIVA_AZUL_TOM,
          profundidadeNossa: comTamanho.tiers.length,
        }),
      ).toMatchObject({ acao: 'init', mudouProfundidade: true });

      for (const modelos of [[], [modeloVivo({ model_id: 0, tier_index: [1] })]]) {
        const viva = arvore(['Azul', 'Tom inventada'], modelos);
        const r = montarTiers(
          args({ grupos: [grupoComTom('Tom inventado')], filhos: AZUL_E_TOM, viva }),
        );
        expect(r.problemas, JSON.stringify(modelos)).toEqual([]);
        expect(opcoesDe(r)).toContainEqual(['v-tom', 11, 'Tom inventado']);
        expect(
          reconciliarModelos({
            montados: r.modelos,
            armazenados: [],
            viva,
            profundidadeNossa: r.tiers.length,
          }).acao,
        ).toBe('init');
      }
    });

    it('⛔ QUASE (a criação): sem árvore viva não há par, e a guarda do anexo nunca dispara — a variante vai sob a linha 11', () => {
      for (const viva of [null, undefined]) {
        const r = montarTiers(
          args({ grupos: [grupoComTom('Tom inventado')], filhos: AZUL_E_TOM, viva }),
        );
        expect(r.problemas).toEqual([]);
        expect(opcoesDe(r)).toEqual([
          ['v-azul', 9, 'Azul'],
          ['v-tom', 11, 'Tom inventado'],
        ]);
      }
    });

    it('⚠️ PERGUNTA (Lucas): uma variante NOVA no ERP — o filho ainda não tem modelo no anúncio — ligada à linha PADRÃO 12 é um anexo no mesmo par, e é RECUSADA com a frase decidida, embora nenhum modelo se mova e o anúncio não tenha opção para onde renomeá-la', () => {
      // The decision (Q1) refuses EVERY append in this pairing. For this child the
      // sentence's «moveria o modelo» and «Renomeie… para o nome da opção do
      // anúncio» do not fit: no model of it exists, and the live tier has no option
      // named «Verde inventado». The operator gets here by following the §5-7
      // sentence's own first exit: the new variante had no row, and binding it to
      // option 12 gave it one. `montarTiers` does hold each child's stored link
      // fields (`linkModelId`, `tierIndexArmazenado`, `sku`), but WHICH live model a
      // child binds is `reconciliarModelos`' decision (stored id → sku → coordinate,
      // plus a synthetic candidate per child), so telling this child from p-tom
      // above here would re-derive that binding, a second copy. The same misfit
      // holds for an unlinked child whose live model's SKU differs: the reconciler
      // would ADD a model for it, and none would move. Pinned as built; whether to
      // narrow it is open for Lucas.
      const viva = arvore(
        ['Azul'],
        [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
      );
      const novo = filho({
        produtoId: 'p-verde-novo',
        variacoesUid: [varianteFakePath('g-cor', 'v-tom')],
        linkModelId: null,
        linkDocId: null,
      });
      const r = montarTiers(
        args({
          grupos: [
            grupoComTom('Verde inventado', [
              entrada88({
                shopee_option_id: 12,
                shopee_option_name: 'Verde inventado',
                arakene_variation_id: ['v-tom'],
              }),
            ]),
          ],
          filhos: [SO_AZUL[0]!, novo],
          viva,
        }),
      );
      expect(r.problemas).toEqual([
        recusaDoAnexo('Verde inventado'),
        naoTemPosicao('p-verde-novo'),
      ]);
      expect(opcoesDe(r)).toEqual([['v-azul', 0, 'Azul']]);
      const armazenadoAzul: ModeloArmazenado = {
        produtoId: 'p-azul',
        linkDocId: 'l-azul',
        modelId: AZUL,
        modelSku: 'AZ',
        tierIndex: [0],
      };
      // `modelList` holds only LIVE models, so this records the fixture (AZUL at
      // [0], with or without the guard), never the guard itself.
      expect(
        reconciliarModelos({
          montados: r.modelos,
          armazenados: [armazenadoAzul],
          viva,
          profundidadeNossa: r.tiers.length,
        }).modelList,
      ).toEqual([{ model_id: AZUL, tier_index: [0] }]);
      // What shows that nothing of this child would have moved is its twin: the SAME
      // grupo and child against a live STANDARD tier 88 is appended, and the
      // reconciler ADDS a model for the child (`novos`) while AZUL keeps [0].
      const viva88: ArvoreVivaDoItem = {
        tier_variation: [
          shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
        ],
        standardise_tier_variation: [
          shopeeStandardiseTierVariationSchema.parse({
            variation_id: 88,
            variation_name: 'Cor',
            variation_option_list: [{ variation_option_id: 9, variation_option_name: 'Azul' }],
          }),
        ],
        model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
      };
      const gemea = montarTiers(
        args({
          grupos: [
            grupoComTom('Verde inventado', [
              entrada88({
                shopee_option_id: 12,
                shopee_option_name: 'Verde inventado',
                arakene_variation_id: ['v-tom'],
              }),
            ]),
          ],
          filhos: [SO_AZUL[0]!, novo],
          viva: viva88,
        }),
      );
      expect(gemea.problemas).toEqual([]);
      const planoGemeo = reconciliarModelos({
        montados: gemea.modelos,
        armazenados: [armazenadoAzul],
        viva: viva88,
        profundidadeNossa: gemea.tiers.length,
      });
      expect(planoGemeo.modelList).toEqual([{ model_id: AZUL, tier_index: [0] }]);
      expect(planoGemeo.novos.map((m) => [m.produtoId, m.tier_index])).toEqual([
        ['p-verde-novo', [1]],
      ]);
    });

    it('⛔ QUASE ({v} como está): a variante « Tom inventado » (as PONTAS) não casa com «Tom inventada» nem dobrada ⇒ RECUSADA, e {v} cita o nome da variante COMO ESTÁ, com as pontas — como a frase §5-7', () => {
      const r = montarTiers(
        args({ grupos: [grupoComTom(' Tom inventado ')], filhos: AZUL_E_TOM, viva: VIVA_AZUL_TOM }),
      );
      expect(r.problemas).toEqual([recusaDoAnexo(' Tom inventado '), naoTemPosicao('p-tom')]);
    });

    it('⛔ QUASE (tier vivo PADRÃO de opções ilegíveis): o tier vivo 88 cuja lista padronizada não pareia com as opções (todo optionId lido 0) continua PADRÃO — o filho novo ligado à opção 12 é ANEXADO como hoje, sem recusa', () => {
      const viva88SemIds: ArvoreVivaDoItem = {
        tier_variation: [
          shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
        ],
        standardise_tier_variation: [
          shopeeStandardiseTierVariationSchema.parse({
            variation_id: 88,
            variation_name: 'Cor',
            variation_option_list: [
              { variation_option_id: 9, variation_option_name: 'Azul' },
              { variation_option_id: 10, variation_option_name: 'Opção inventada 1' },
            ],
          }),
        ],
        model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
      };
      // The reader keeps the tier STANDARD but reads every option id as 0 (the two
      // option lists differ in length) — the shape a "custom = every id 0" test
      // would mistake for a custom tier.
      expect(tiersVivosDe(viva88SemIds)[0]).toMatchObject({
        variationId: 88,
        opcoes: [{ optionId: 0, nome: 'Azul' }],
      });
      const r = montarTiers(
        args({
          grupos: [
            grupoComTom('Tom inventado', [
              entrada88({
                shopee_option_id: 12,
                shopee_option_name: 'Tom inventado',
                arakene_variation_id: ['v-tom'],
              }),
            ]),
          ],
          filhos: AZUL_E_TOM,
          viva: viva88SemIds,
        }),
      );
      expect(r.problemas).toEqual([]);
      expect(opcoesDe(r)).toEqual([
        ['v-azul', 0, 'Azul'],
        ['v-tom', 12, 'Tom inventado'],
      ]);
    });

    it('⚠️ PAR (o nome da LINHA não reivindica): a linha PADRÃO {11, «Tom inventada»} tem o MESMO nome da opção viva, mas só uma linha de id 0 ou o nome da VARIANTE reivindicam — «Tom inventado» seria anexada sob 11 e moveria o modelo ⇒ RECUSADA', () => {
      const r = montarTiers(
        args({
          grupos: [
            grupoComTom('Tom inventado', [
              entrada88({
                shopee_option_id: 11,
                shopee_option_name: 'Tom inventada',
                arakene_variation_id: ['v-tom'],
              }),
            ]),
          ],
          filhos: AZUL_E_TOM,
          viva: VIVA_AZUL_TOM,
        }),
      );
      expect(r.problemas).toEqual([recusaDoAnexo('Tom inventado'), naoTemPosicao('p-tom')]);
      expect(opcoesDe(r)).toEqual([
        ['v-azul', 0, 'Azul'],
        [null, 0, 'Tom inventada'],
      ]);
    });

    /* ---- where the sentence does not fit: pinned as built, open for Lucas -- */

    /** The STANDARD entry 88 with exactly the given rows. */
    const entrada88ComLinhas = (linhas: readonly OpcaoDeEntrada[]): unknown => ({
      ...(entradaPadrao({ variation_id: 88, variationOptions: linhas }) as object),
      name: 'Camisetas',
    });
    const VIVA_SO_AZUL = arvore(
      ['Azul'],
      [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
    );

    it('⚠️ PERGUNTA (Lucas): DUAS variantes USADAS que cairiam na MESMA opção leem como a frase do anexo (Q1), nunca combinacao-duplicada como sob a entrada CUSTOM — e renomear a segunda para o nome da opção viva NÃO sai da recusa: {v} vira o próprio nome da opção', () => {
      // (a) ONE id-0 row binds both variantes. The row claims the live «Azul» for
      // v-um (the first used variante in it); v-dois would be appended as
      // {0, «Azul»}, and the Q1 branch refuses it BEFORE the duplicate-key check
      // could see the second «Azul».
      const linhaDeDuas: OpcaoDeEntrada = {
        shopee_option_id: 0,
        shopee_option_name: 'Azul',
        arakene_variation_id: ['v-um', 'v-dois'],
      };
      const publicar = (nomeDoDois: string, links: readonly unknown[]) =>
        montarTiers(
          args({
            grupos: [
              grupo({
                grupoId: 'g-cor',
                nome: 'Cor',
                variacoes: [variante('v-um', 'Um inventado'), variante('v-dois', nomeDoDois)],
                linksVariacoesShopee: links,
              }),
            ],
            filhos: [
              filho({
                produtoId: 'p-um',
                sku: 'AZ',
                variacoesUid: [varianteFakePath('g-cor', 'v-um')],
              }),
              filho({ produtoId: 'p-dois', variacoesUid: [varianteFakePath('g-cor', 'v-dois')] }),
            ],
            viva: VIVA_SO_AZUL,
          }),
        );
      const sob88 = publicar('Dois inventado', [entrada88ComLinhas([linhaDeDuas])]);
      expect(sob88.problemas).toEqual([recusaDoAnexo('Dois inventado'), naoTemPosicao('p-dois')]);
      expect(opcoesDe(sob88)).toEqual([['v-um', 0, 'Azul']]);
      // The sentence's first exit, followed: v-dois renamed to «Azul». Still refused,
      // and «não casa pelo nome» is now false — the row gave the option to v-um.
      expect(publicar('Azul', [entrada88ComLinhas([linhaDeDuas])]).problemas).toEqual([
        recusaDoAnexo('Azul'),
        naoTemPosicao('p-dois'),
      ]);
      // ⛔ The SAME rows under a CUSTOM entry: the accurate refusal, unchanged.
      expect(
        motivos(
          publicar('Dois inventado', [
            entrada({ variation_id: 0, variationOptions: [linhaDeDuas] }),
          ]).problemas,
        ),
      ).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada]);

      // (b) ONE non-zero row 11 binds two used variantes, neither named like the live
      // option. Before Q1 both were appended under 11 (combinacao-duplicada, id 11);
      // now each gets the Q1 sentence, then each child its model line.
      const r = montarTiers(
        args({
          grupos: [
            grupo({
              grupoId: 'g-cor',
              nome: 'Cor',
              variacoes: [
                azul,
                variante('v-tom', 'Tom inventado'),
                variante('v-tom2', 'Tom inventado dois'),
              ],
              linksVariacoesShopee: [
                entrada88ComLinhas([
                  {
                    shopee_option_id: 9,
                    shopee_option_name: 'Azul',
                    arakene_variation_id: ['v-azul'],
                  },
                  {
                    shopee_option_id: 11,
                    shopee_option_name: 'Tom inventado',
                    arakene_variation_id: ['v-tom', 'v-tom2'],
                  },
                ]),
              ],
            }),
          ],
          filhos: [
            ...AZUL_E_TOM,
            filho({ produtoId: 'p-tom2', variacoesUid: [varianteFakePath('g-cor', 'v-tom2')] }),
          ],
          viva: VIVA_AZUL_TOM,
        }),
      );
      expect(r.problemas).toEqual([
        recusaDoAnexo('Tom inventado'),
        recusaDoAnexo('Tom inventado dois'),
        naoTemPosicao('p-tom'),
        naoTemPosicao('p-tom2'),
      ]);
    });

    it('⚠️ PERGUNTA (Lucas): a variante usada JÁ com o nome da opção viva («Azul») é RECUSADA quando uma homônima ANTERIOR no grupo, sem filho nesta publicação, reivindica a opção pelo nome — {v} é o próprio nome da opção, e só tirar a homônima do grupo sai da recusa', () => {
      // The name rung of `varianteDaOpcaoViva` takes the FIRST homonym in grupo
      // order, used or not (its row rung prefers a used variante). Grupos are shared
      // across produtos, so v-a may belong to another produto.
      const linhas: readonly OpcaoDeEntrada[] = [
        { shopee_option_id: 9, shopee_option_name: 'Azul', arakene_variation_id: ['v-a'] },
        { shopee_option_id: 10, shopee_option_name: 'Azul', arakene_variation_id: ['v-b'] },
      ];
      const pB = filho({
        produtoId: 'p-b',
        sku: 'AZ',
        linkDocId: 'l-b',
        linkModelId: AZUL,
        variacoesUid: [varianteFakePath('g-cor', 'v-b')],
      });
      const publicar = (variacoes: readonly VarianteDoTier[]) =>
        montarTiers(
          args({
            grupos: [
              grupo({
                grupoId: 'g-cor',
                nome: 'Cor',
                variacoes,
                linksVariacoesShopee: [entrada88ComLinhas(linhas)],
              }),
            ],
            filhos: [pB],
            viva: VIVA_SO_AZUL,
          }),
        );
      const comHomonima = publicar([variante('v-a', 'Azul'), variante('v-b', 'Azul')]);
      expect(comHomonima.problemas).toEqual([recusaDoAnexo('Azul'), naoTemPosicao('p-b')]);
      expect(opcoesDe(comHomonima)).toEqual([['v-a', 0, 'Azul']]);
      // ⛔ Without the unused homonym (an exit the sentence does not name), v-b is
      // claimed by its name and keeps the position.
      const semHomonima = publicar([variante('v-b', 'Azul')]);
      expect(semHomonima.problemas).toEqual([]);
      expect(opcoesDe(semHomonima)).toEqual([['v-b', 0, 'Azul']]);
      expect(semHomonima.modelos.map((m) => [m.produtoId, m.tier_index])).toEqual([['p-b', [0]]]);
    });

    it('⚠️ PERGUNTA (Lucas): uma linha de id 0 com o nome da opção viva que liga OUTRA variante, sem filho, reivindica a opção — a variante usada de MESMO nome, com a linha padrão 9 dela, é RECUSADA com {v} = o nome da opção; a saída é essa linha, que a frase não nomeia', () => {
      const linhaAzul: OpcaoDeEntrada = {
        shopee_option_id: 9,
        shopee_option_name: 'Azul',
        arakene_variation_id: ['v-azul'],
      };
      const publicar = (linhas: readonly OpcaoDeEntrada[]) =>
        montarTiers(
          args({
            grupos: [
              grupo({
                grupoId: 'g-cor',
                nome: 'Cor',
                variacoes: [azul, variante('v-x', 'Opção inventada 1')],
                linksVariacoesShopee: [entrada88ComLinhas(linhas)],
              }),
            ],
            filhos: SO_AZUL,
            viva: VIVA_SO_AZUL,
          }),
        );
      const comLinhaVelha = publicar([
        linhaAzul,
        { shopee_option_id: 0, shopee_option_name: 'Azul', arakene_variation_id: ['v-x'] },
      ]);
      expect(comLinhaVelha.problemas).toEqual([recusaDoAnexo('Azul'), naoTemPosicao('p-azul')]);
      expect(opcoesDe(comLinhaVelha)).toEqual([['v-x', 0, 'Azul']]);
      // ⛔ Without the stale id-0 row, v-azul is claimed by its name: no refusal.
      const semLinhaVelha = publicar([linhaAzul]);
      expect(semLinhaVelha.problemas).toEqual([]);
      expect(opcoesDe(semLinhaVelha)).toEqual([['v-azul', 0, 'Azul']]);
    });

    it('⚠️ PERGUNTA (Lucas): a SEGUNDA saída da frase, seguida — os filhos movidos para OUTRO grupo de MESMO nome do tier, SEM entrada (custom implícito), com a variante de nome DIFERENTE da opção viva: NADA recusa e o modelo do filho MUDA de posição (a classe do ponto aberto 6 do P14a, não construída); de OUTRO nome, o grupo recebe S1', () => {
      const movidos = (grupoId: string) => [
        filho({
          produtoId: 'p-azul',
          sku: 'AZ',
          linkDocId: 'l-azul',
          variacoesUid: [varianteFakePath(grupoId, 'w-azul')],
        }),
        filho({
          produtoId: 'p-tom',
          sku: 'TOM',
          linkDocId: 'l-tom',
          variacoesUid: [varianteFakePath(grupoId, 'w-tom')],
        }),
      ];
      const grupoNovo = (grupoId: string, nome: string) =>
        grupo({
          grupoId,
          nome,
          variacoes: [variante('w-azul', 'Azul'), variante('w-tom', 'Tom inventado')],
          linksVariacoesShopee: null,
        });
      const r = montarTiers(
        args({ grupos: [grupoNovo('g-2', 'Cor')], filhos: movidos('g-2'), viva: VIVA_AZUL_TOM }),
      );
      expect(r.problemas).toEqual([]);
      expect(opcoesDe(r)).toEqual([
        ['w-azul', 0, 'Azul'],
        [null, 0, 'Tom inventada'],
        ['w-tom', 0, 'Tom inventado'],
      ]);
      const plano = reconciliarModelos({
        montados: r.modelos,
        armazenados: [
          {
            produtoId: 'p-azul',
            linkDocId: 'l-azul',
            modelId: AZUL,
            modelSku: 'AZ',
            tierIndex: [0],
          },
          { produtoId: 'p-tom', linkDocId: 'l-tom', modelId: TOM, modelSku: 'TOM', tierIndex: [1] },
        ],
        viva: VIVA_AZUL_TOM,
        profundidadeNossa: r.tiers.length,
      });
      // The harm the Q1 sentence warns of, unrefused: TOM leaves «Tom inventada».
      expect(plano.modelList).toEqual([
        { model_id: AZUL, tier_index: [0] },
        { model_id: TOM, tier_index: [2] },
      ]);

      // ⛔ Moved to a grupo named otherwise: it pairs with no live tier ⇒ S1.
      expect(
        montarTiers(
          args({
            grupos: [grupoNovo('g-3', 'Cores')],
            filhos: movidos('g-3'),
            viva: VIVA_AZUL_TOM,
          }),
        ).problemas,
      ).toEqual([
        {
          campo: 'standardise_tier_variation',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          mensagem: TEXTO_NAO_CASA('Cores'),
        },
      ]);
    });
  });

  it('⛔ QUASE: uma entrada de OUTRA conta ou categoria carregando 77, À FRENTE da nossa 88, não reivindica o tier vivo 77 ⇒ variacao-sem-vinculo nomeando 88', () => {
    for (const estrangeira of [
      entradaPadrao({ integracaoShopeeId: 'int-12' }),
      entradaPadrao({ category_id: 999999 }),
    ]) {
      const r = montarTiers(
        args({
          grupos: [grupoCor([estrangeira, ENTRADA_88])],
          filhos: SO_AZUL,
          viva: vivaPadrao77(),
        }),
      );
      expect(r.problemas).toEqual([recusaPadrao('Cor', 88)]);
      expect(r.tiers).toEqual([]);
      expect(r.modelos).toEqual([]);
    }
  });

  it('⚠️ PAR: a nossa 77 vale mesmo atrás de uma 88 de OUTRA conta', () => {
    const r = montarTiers(
      args({
        grupos: [
          grupoCor([
            entradaPadrao({ integracaoShopeeId: 'int-12', variation_id: 88 }),
            entradaPadrao(),
          ]),
        ],
        filhos: SO_AZUL,
        viva: vivaPadrao77(),
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(r.tiers.map((t) => t.variation_id)).toEqual([77]);
  });

  it('⚠️ DOIS grupos guardam a entrada 77: o tier vivo 77 casa com UM só — o outro é recusado, embora o tier exista; QUASE: nomeado como o tier custom vivo, ele casa pelo nome e não é recusado', () => {
    const viva: ArvoreVivaDoItem = {
      tier_variation: [
        shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
        shopeeTierVariationSchema.parse({ name: 'Tamanho', option_list: [{ option: 'P' }] }),
      ],
      standardise_tier_variation: [
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: 77,
          variation_name: 'Cor',
          variation_option_list: [{ variation_option_id: 5, variation_option_name: 'Azul' }],
        }),
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: 0,
          variation_name: 'Tamanho',
          variation_option_list: [{ variation_option_id: 0, variation_option_name: 'P' }],
        }),
      ],
      model: [modeloVivo({ model_id: AZUL, tier_index: [0, 0], model_sku: 'AZ-P' })],
    };
    const segundoGrupo = (nome: string): GrupoParaTier =>
      grupo({
        grupoId: 'g-2',
        nome,
        ordem: 2,
        variacoes: [variante('v-p', 'P')],
        linksVariacoesShopee: [entradaPadrao()],
      });
    const filhos = [
      filho({
        produtoId: 'p-azul-p',
        variacoesUid: [varianteFakePath('g-cor', 'v-azul'), varianteFakePath('g-2', 'v-p')],
      }),
    ];

    const perde = montarTiers(
      args({ grupos: [grupoCor([entradaPadrao()]), segundoGrupo('Eixo inventado')], filhos, viva }),
    );
    expect(perde.problemas).toEqual([recusaPadrao('Eixo inventado', 77)]);
    expect(perde.tiers.map((t) => t.grupoId)).toEqual(['g-cor']);
    expect(perde.modelos).toEqual([]);

    const casa = montarTiers(
      args({ grupos: [grupoCor([entradaPadrao()]), segundoGrupo('Tamanho')], filhos, viva }),
    );
    expect(casa.problemas).toEqual([]);
  });

  describe('formas sem medida na fiação: a recusa é fixada, não a exatidão da frase', () => {
    // No committed body shows these shapes, and the package's schema tolerates them
    // (README). `tiersDoItem` iterates `tier_variation` and pairs the standard tree
    // only at EQUAL length, so a stored id may be live on the wire and still read as
    // absent here: the refusal fails closed, while its sentence can be inaccurate.
    const PADRAO_77 = shopeeStandardiseTierVariationSchema.parse({
      variation_id: 77,
      variation_name: 'Cor',
      variation_option_list: [{ variation_option_id: 5, variation_option_name: 'Azul' }],
    });
    const UM_MODELO = [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })];

    it('⚠️ só a árvore PADRÃO, com a entrada 77 na mesma profundidade: recusado, tiers e modelos vazios', () => {
      const viva: ArvoreVivaDoItem = {
        tier_variation: null,
        standardise_tier_variation: [PADRAO_77],
        model: UM_MODELO,
      };
      const r = montarTiers(args({ grupos: [grupoCor([entradaPadrao()])], filhos: SO_AZUL, viva }));
      expect(r.problemas).toEqual([recusaPadrao('Cor', 77)]);
      expect(r.tiers).toEqual([]);
      expect(r.modelos).toEqual([]);
    });

    it('⚠️ só a árvore PADRÃO, com a entrada 88: recusado, nomeando 88', () => {
      const viva: ArvoreVivaDoItem = {
        tier_variation: null,
        standardise_tier_variation: [PADRAO_77],
        model: UM_MODELO,
      };
      const r = montarTiers(args({ grupos: [grupoCor([ENTRADA_88])], filhos: SO_AZUL, viva }));
      expect(r.problemas).toEqual([recusaPadrao('Cor', 88)]);
    });

    it('⚠️ as duas árvores ausentes, com a entrada 77: recusado, tiers e modelos vazios', () => {
      const viva: ArvoreVivaDoItem = {
        tier_variation: null,
        standardise_tier_variation: null,
        model: UM_MODELO,
      };
      const r = montarTiers(args({ grupos: [grupoCor([entradaPadrao()])], filhos: SO_AZUL, viva }));
      expect(r.problemas).toEqual([recusaPadrao('Cor', 77)]);
      expect(r.tiers).toEqual([]);
      expect(r.modelos).toEqual([]);
    });

    it('⚠️ DOIS tiers contra UMA entrada padrão, grupo de outro nome: recusado — o Tamanho custom casado segue', () => {
      const viva: ArvoreVivaDoItem = {
        tier_variation: [
          shopeeTierVariationSchema.parse({ name: 'Estampa', option_list: [{ option: 'Azul' }] }),
          shopeeTierVariationSchema.parse({ name: 'Tamanho', option_list: [{ option: 'P' }] }),
        ],
        standardise_tier_variation: [PADRAO_77],
        model: [modeloVivo({ model_id: AZUL, tier_index: [0, 0], model_sku: 'AZ-P' })],
      };
      const r = montarTiers(
        args({ grupos: [grupoCor([entradaPadrao()]), tam], filhos: AZUL_P, viva }),
      );
      expect(r.problemas).toEqual([recusaPadrao('Cor', 77)]);
      expect(r.tiers.map((t) => t.grupoId)).toEqual(['g-tam']);
      expect(r.modelos).toEqual([]);
    });

    it('⚠️ comprimentos diferentes (#1911 P14b, Q1): o tier PADRÃO 88 no fio (UM tier_variation, DUAS entradas padronizadas) é lido CUSTOM e casa pelo nome com a entrada 88 — o filho novo ligado à opção 12 é RECUSADO pela frase do anexo, que chama de «personalizado» um tier padrão: falha fechada, frase inexata', () => {
      const viva: ArvoreVivaDoItem = {
        tier_variation: [
          shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: 'Azul' }] }),
        ],
        standardise_tier_variation: [
          shopeeStandardiseTierVariationSchema.parse({
            variation_id: 88,
            variation_name: 'Cor',
            variation_option_list: [{ variation_option_id: 9, variation_option_name: 'Azul' }],
          }),
          shopeeStandardiseTierVariationSchema.parse({
            variation_id: 0,
            variation_name: 'Outro eixo inventado',
            variation_option_list: [],
          }),
        ],
        model: UM_MODELO,
      };
      expect(tiersVivosDe(viva)[0]).toMatchObject({ variationId: 0, nome: 'Cor' });
      const r = montarTiers(
        args({
          grupos: [
            grupo({
              grupoId: 'g-cor',
              nome: 'Cor',
              variacoes: [azul, variante('v-novo', 'Verde inventado')],
              linksVariacoesShopee: [
                {
                  ...(entradaPadrao({
                    variation_id: 88,
                    variationOptions: [
                      {
                        shopee_option_id: 9,
                        shopee_option_name: 'Azul',
                        arakene_variation_id: ['v-azul'],
                      },
                      {
                        shopee_option_id: 12,
                        shopee_option_name: 'Verde inventado',
                        arakene_variation_id: ['v-novo'],
                      },
                    ],
                  }) as object),
                  name: 'Camisetas',
                },
              ],
            }),
          ],
          filhos: [
            SO_AZUL[0]!,
            filho({ produtoId: 'p-novo', variacoesUid: [varianteFakePath('g-cor', 'v-novo')] }),
          ],
          viva,
        }),
      );
      expect(r.problemas).toEqual([
        {
          campo: 'standardise_tier_variation',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          mensagem: TEXTO_ANEXO_SOB_PADRAO('Verde inventado', 'Cor', 'Cor', 88),
        },
        {
          campo: 'model',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          mensagem:
            'A variação p-novo não tem posição no grupo "Cor" e o modelo não pode ser colocado.',
        },
      ]);
    });

    it('⚠️ QUASE: sem árvore nenhuma, em OUTRA profundidade ⇒ sem recusa — é init_tier_variation', () => {
      const viva: ArvoreVivaDoItem = {
        tier_variation: null,
        standardise_tier_variation: null,
        model: UM_MODELO,
      };
      const r = montarTiers(
        args({ grupos: [grupoCor([entradaPadrao()]), tam], filhos: AZUL_P, viva }),
      );
      expect(r.problemas).toEqual([]);
      const plano = reconciliarModelos({
        montados: r.modelos,
        armazenados: [],
        viva,
        profundidadeNossa: r.tiers.length,
      });
      expect(plano).toMatchObject({ acao: 'init', mudouProfundidade: true });
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  (2d) #1911 batch-A — the NAME fold: one string sent, read back, compared  */
/* -------------------------------------------------------------------------- */

describe('montarTiers — #1911 batch-A: os NOMES de tier e de opção passam pela MESMA dobra (as pontas) na ida, na volta e no pareamento', () => {
  const AZUL = MODEL_ID + 1;
  const VERDE = MODEL_ID;

  /** A live CUSTOM tree, the option names RAW (the reader folds them). */
  function viva(
    nomeDoTier: string,
    opcoes: readonly string[],
    modelos: readonly ShopeeModel[],
  ): ArvoreVivaDoItem {
    return {
      tier_variation: [
        shopeeTierVariationSchema.parse({
          name: nomeDoTier,
          option_list: opcoes.map((option) => ({ option })),
        }),
      ],
      standardise_tier_variation: null,
      model: modelos,
    };
  }

  function grupoCom(
    nome: string,
    variacoes: readonly VarianteDoTier[],
    linksVariacoesShopee: readonly unknown[] | null = null,
  ): GrupoParaTier {
    return grupo({ grupoId: 'g-cor', nome, variacoes, linksVariacoesShopee });
  }

  function filhoDe(produtoId: string, varianteId: string, sku: string): FilhoParaPublicar {
    return filho({
      produtoId,
      sku,
      linkDocId: `l-${produtoId}`,
      variacoesUid: [varianteFakePath('g-cor', varianteId)],
    });
  }

  /** Live 'Cor' = [Verde, Azul], one model on each — the shape of VIVA_COR above. */
  const MODELOS_VIVOS = [
    modeloVivo({ model_id: VERDE, tier_index: [0], model_sku: 'VD' }),
    modeloVivo({ model_id: AZUL, tier_index: [1], model_sku: 'AZ' }),
  ];
  const ARMAZENADOS: readonly ModeloArmazenado[] = [
    { produtoId: 'p-azul', linkDocId: 'l-p-azul', modelId: AZUL, modelSku: 'AZ', tierIndex: [1] },
    {
      produtoId: 'p-verde',
      linkDocId: 'l-p-verde',
      modelId: VERDE,
      modelSku: 'VD',
      tierIndex: [0],
    },
  ];
  const FILHOS = [filhoDe('p-azul', 'v-azul', 'AZ'), filhoDe('p-verde', 'v-verde', 'VD')];

  it("⚠️ PAR: a variante 'Azul ' (e ' Azul', e com NBSP) CASA com a opção viva 'Azul' — o índice vivo fica, nenhuma opção fantasma, e o leg é 'nenhuma'", () => {
    // P7-F1/F2/F5: before the fold, the live 'Azul' stayed a model-less orphan,
    // a twin 'Azul ' was appended and the model moved to it — on EVERY republish.
    for (const nomeAzul of ['Azul ', ' Azul', '\u00a0Azul']) {
      // The live tree holds 'Azul' or exactly what an unfolded create sent.
      for (const vivoAzul of ['Azul', 'Azul ']) {
        const arvore = viva('Cor', ['Verde', vivoAzul], MODELOS_VIVOS);
        const r = montarTiers(
          args({
            grupos: [grupoCom('Cor', [variante('v-azul', nomeAzul), variante('v-verde', 'Verde')])],
            filhos: FILHOS,
            viva: arvore,
          }),
        );
        const rotulo = `${JSON.stringify(nomeAzul)} × ${JSON.stringify(vivoAzul)}`;
        expect(r.problemas, rotulo).toEqual([]);
        expect(
          r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_name]),
          rotulo,
        ).toEqual([
          ['v-verde', 'Verde'],
          ['v-azul', 'Azul'],
        ]);
        expect(
          r.modelos.map((m) => [m.produtoId, m.tier_index]),
          rotulo,
        ).toEqual([
          ['p-azul', [1]],
          ['p-verde', [0]],
        ]);
        const plano = reconciliarModelos({
          montados: r.modelos,
          armazenados: ARMAZENADOS,
          viva: arvore,
          profundidadeNossa: r.tiers.length,
        });
        expect(plano.acao, rotulo).toBe('nenhuma');
        expect(plano.modelList, rotulo).toEqual([
          { model_id: VERDE, tier_index: [0] },
          { model_id: AZUL, tier_index: [1] },
        ]);
      }
    }
  });

  it("⚠️ PAR (ida e volta): o CREATE manda 'Cor' / 'Azul' — e realimentado como árvore viva, o republish não muda NADA", () => {
    for (const [nomeGrupo, nomeAzul] of [
      ['Cor ', 'Azul '],
      [' Cor', ' Azul'],
      ['Cor', 'Azul\u00a0'],
    ] as const) {
      const grupos = [
        grupoCom(nomeGrupo, [variante('v-azul', nomeAzul), variante('v-verde', 'Verde')]),
      ];
      const rotulo = `${JSON.stringify(nomeGrupo)} / ${JSON.stringify(nomeAzul)}`;

      const criacao = montarTiers(args({ grupos, filhos: FILHOS, viva: null }));
      expect(criacao.problemas, rotulo).toEqual([]);
      expect(
        criacao.tiers.map((t) => t.variation_name),
        rotulo,
      ).toEqual(['Cor']);
      expect(
        criacao.tiers[0]!.opcoes.map((o) => o.variation_option_name),
        rotulo,
      ).toEqual(['Azul', 'Verde']);

      // Shopee now holds EXACTLY what was sent, one model per created position.
      const arvore = viva(
        criacao.tiers[0]!.variation_name!,
        criacao.tiers[0]!.opcoes.map((o) => o.variation_option_name),
        criacao.modelos.map((m, i) =>
          modeloVivo({
            model_id: MODEL_ID + 10 + i,
            tier_index: m.tier_index,
            model_sku: m.model_sku ?? null,
          }),
        ),
      );
      const armazenados = criacao.modelos.map((m, i) => ({
        produtoId: m.produtoId,
        linkDocId: `l-${m.produtoId}`,
        modelId: MODEL_ID + 10 + i,
        modelSku: m.model_sku ?? null,
        tierIndex: m.tier_index,
      }));

      const republish = montarTiers(args({ grupos, filhos: FILHOS, viva: arvore }));
      expect(republish.problemas, rotulo).toEqual([]);
      expect(republish.tiers, rotulo).toEqual(criacao.tiers);
      const plano = reconciliarModelos({
        montados: republish.modelos,
        armazenados,
        viva: arvore,
        profundidadeNossa: republish.tiers.length,
      });
      expect(plano.acao, rotulo).toBe('nenhuma');
      expect(plano.novos, rotulo).toEqual([]);
    }
  });

  it("⚠️ PAR: um shopee_option_name ARMAZENADO 'Azul ' (digitado) casa com a opção viva 'Azul' — e no create vai ao fio como 'Azul'", () => {
    // The variante is named otherwise, so ONLY the stored entry's name can bind.
    const entradaDigitada = entrada({
      variation_id: 0,
      variationOptions: [
        { shopee_option_id: 0, shopee_option_name: 'Azul ', arakene_variation_id: ['v-azul'] },
      ],
    });
    const grupos = [grupoCom('Cor', [variante('v-azul', 'Celeste')], [entradaDigitada])];
    const filhos = [FILHOS[0]!];

    const atualizacao = montarTiers(
      args({
        grupos,
        filhos,
        viva: viva('Cor', ['Azul'], [modeloVivo({ model_id: AZUL, tier_index: [0] })]),
      }),
    );
    expect(atualizacao.problemas).toEqual([]);
    expect(atualizacao.tiers[0]!.opcoes.map((o) => o.varianteId)).toEqual(['v-azul']);
    expect(atualizacao.modelos.map((m) => m.tier_index)).toEqual([[0]]);

    const criacao = montarTiers(args({ grupos, filhos, viva: null }));
    expect(criacao.problemas).toEqual([]);
    expect(criacao.tiers[0]!.opcoes.map((o) => o.variation_option_name)).toEqual(['Azul']);
  });

  it("⚠️ QUASE: 'azul' (a CAIXA) e 'Azul  Claro' (DOIS espaços dentro) NÃO casam — a opção viva fica órfã no seu índice e a nossa é ANEXADA", () => {
    for (const [nossa, vivoNome] of [
      ['azul', 'Azul'],
      ['AZUL', 'Azul'],
      ['Azul  Claro', 'Azul Claro'],
    ] as const) {
      const r = montarTiers(
        args({
          grupos: [grupoCom('Cor', [variante('v-azul', nossa), variante('v-verde', 'Verde')])],
          filhos: FILHOS,
          viva: viva('Cor', ['Verde', vivoNome], MODELOS_VIVOS),
        }),
      );
      expect(r.problemas, nossa).toEqual([]);
      expect(
        r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_name]),
        nossa,
      ).toEqual([
        ['v-verde', 'Verde'],
        [null, vivoNome],
        ['v-azul', nossa],
      ]);
      expect(r.modelos.find((m) => m.produtoId === 'p-azul')?.tier_index, nossa).toEqual([2]);
    }
  });

  it("⛔ COLISÃO: as variantes 'Azul' e 'Azul ' do MESMO grupo dobram para a mesma opção ⇒ combinacao-duplicada, nunca duas opções", () => {
    const r = montarTiers(
      args({
        grupos: [grupoCom('Cor', [variante('v-a1', 'Azul'), variante('v-a2', 'Azul ')])],
        filhos: [filhoDe('p-1', 'v-a1', 'A1'), filhoDe('p-2', 'v-a2', 'A2')],
      }),
    );
    expect(motivos(r.problemas)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada);
    // ⛔ quase-par: 'Azul' e 'azul' são DUAS opções — a caixa não dobra.
    const caixa = montarTiers(
      args({
        grupos: [grupoCom('Cor', [variante('v-a1', 'Azul'), variante('v-a2', 'azul')])],
        filhos: [filhoDe('p-1', 'v-a1', 'A1'), filhoDe('p-2', 'v-a2', 'A2')],
      }),
    );
    expect(caixa.problemas).toEqual([]);
    expect(caixa.tiers[0]!.opcoes.map((o) => o.variation_option_name)).toEqual(['Azul', 'azul']);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2d-bis) #1911 P14a (M1) — the ERP never renames a LIVE option            */
/* -------------------------------------------------------------------------- */

describe('montarTiers — #1911 P14a (M1): a ATUALIZAÇÃO nunca renomeia uma opção viva; a CRIAÇÃO manda o nome da linha armazenada, senão o da variante', () => {
  const MODELO = MODEL_ID + 1;
  /** Shopee's PUBLIC BR taxonomy: Cor 101054, option 9632. */
  const VARIACAO_COR_BR = 101_054;
  const OPCAO_AZUL_TURQUESA = 9632;

  /**
   * A live tier of ONE option at [0], one model on it; standard when `optionId` ≠ 0.
   * It cannot express the capture's shape, a standard tier holding an id-0 seller
   * option: an id-0 option does not mean a custom tier (that case builds its tree).
   */
  function vivaDeUmaOpcao(nomeDaOpcao: string, optionId: number): ArvoreVivaDoItem {
    return {
      tier_variation: [
        shopeeTierVariationSchema.parse({ name: 'Cor', option_list: [{ option: nomeDaOpcao }] }),
      ],
      standardise_tier_variation:
        optionId === 0
          ? null
          : [
              shopeeStandardiseTierVariationSchema.parse({
                variation_id: VARIACAO_COR_BR,
                variation_name: 'Cor',
                variation_option_list: [
                  { variation_option_id: optionId, variation_option_name: nomeDaOpcao },
                ],
              }),
            ],
      model: [modeloVivo({ model_id: MODELO, tier_index: [0], model_sku: 'TM' })],
    };
  }

  /** The ERP variante is named otherwise than the Shopee option it is bound to. */
  function grupoDe(
    variacoes: readonly VarianteDoTier[],
    linksVariacoesShopee: readonly unknown[] | null,
  ): GrupoParaTier {
    return grupo({ grupoId: 'g-cor', nome: 'Cor', variacoes, linksVariacoesShopee });
  }

  function filhoDe(varianteId: string): FilhoParaPublicar {
    return filho({
      produtoId: `p-${varianteId}`,
      sku: 'TM',
      linkDocId: `l-${varianteId}`,
      variacoesUid: [varianteFakePath('g-cor', varianteId)],
    });
  }

  const tom = variante('v-tom', 'Tom inventado');
  const entradaBr = (shopee_option_name: string) =>
    entrada({
      variation_id: VARIACAO_COR_BR,
      variationOptions: [
        {
          shopee_option_id: OPCAO_AZUL_TURQUESA,
          shopee_option_name,
          arakene_variation_id: ['v-tom'],
        },
      ],
    });

  const opcoesDe = (r: ReturnType<typeof montarTiers>) =>
    r.tiers[0]!.opcoes.map((o) => [o.varianteId, o.variation_option_id, o.variation_option_name]);

  it('⚠️ PAR (atualização): a opção PADRÃO viva 9632 «Azul Turquesa», ligada à variante «Tom inventado», é reenviada como «Azul Turquesa» — nunca com o nome do ERP', () => {
    const r = montarTiers(
      args({
        grupos: [grupoDe([tom], [entradaBr('Azul Turquesa')])],
        filhos: [filhoDe('v-tom')],
        viva: vivaDeUmaOpcao('Azul Turquesa', OPCAO_AZUL_TURQUESA),
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(opcoesDe(r)).toEqual([['v-tom', OPCAO_AZUL_TURQUESA, 'Azul Turquesa']]);
    expect(r.modelos.map((m) => m.tier_index)).toEqual([[0]]);
  });

  it('⚠️ PAR (criação): a MESMA entrada, sem árvore viva, manda o nome ARMAZENADO da linha — «Azul Turquesa»', () => {
    const r = montarTiers(
      args({
        grupos: [grupoDe([tom], [entradaBr('Azul Turquesa')])],
        filhos: [filhoDe('v-tom')],
        viva: null,
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(opcoesDe(r)).toEqual([['v-tom', OPCAO_AZUL_TURQUESA, 'Azul Turquesa']]);
  });

  it('⚠️ QUASE-PAR: a opção CUSTOM viva «Cor inventada», casada pela LINHA {0, «Cor inventada»} com a variante «Cor do ERP», é reenviada como «Cor inventada» — e a criação manda o nome da linha', () => {
    const doErp = variante('v-erp', 'Cor do ERP');
    const linhaCustom = entrada({
      variation_id: 0,
      variationOptions: [
        {
          shopee_option_id: 0,
          shopee_option_name: 'Cor inventada',
          arakene_variation_id: ['v-erp'],
        },
      ],
    });
    const grupos = [grupoDe([doErp], [linhaCustom])];
    const viva = vivaDeUmaOpcao('Cor inventada', 0);

    const atualizacao = montarTiers(args({ grupos, filhos: [filhoDe('v-erp')], viva }));
    expect(atualizacao.problemas).toEqual([]);
    expect(opcoesDe(atualizacao)).toEqual([['v-erp', 0, 'Cor inventada']]);
    const plano = reconciliarModelos({
      montados: atualizacao.modelos,
      armazenados: [
        {
          produtoId: 'p-v-erp',
          linkDocId: 'l-v-erp',
          modelId: MODELO,
          modelSku: 'TM',
          tierIndex: [0],
        },
      ],
      viva,
      profundidadeNossa: atualizacao.tiers.length,
    });
    expect(plano.acao).toBe('nenhuma');

    const criacao = montarTiers(args({ grupos, filhos: [filhoDe('v-erp')], viva: null }));
    expect(opcoesDe(criacao)).toEqual([['v-erp', 0, 'Cor inventada']]);
  });

  it('o tier custom IMPLÍCITO (sem linha): a criação manda o nome da VARIANTE dobrado («Azul » ⇒ «Azul»), e a atualização da viva «Azul» manda «Azul»', () => {
    const grupos = [grupoDe([variante('v-azul', 'Azul ')], null)];
    const filhos = [filhoDe('v-azul')];

    const criacao = montarTiers(args({ grupos, filhos, viva: null }));
    expect(criacao.problemas).toEqual([]);
    expect(opcoesDe(criacao)).toEqual([['v-azul', 0, 'Azul']]);

    const atualizacao = montarTiers(args({ grupos, filhos, viva: vivaDeUmaOpcao('Azul', 0) }));
    expect(atualizacao.problemas).toEqual([]);
    expect(opcoesDe(atualizacao)).toEqual([['v-azul', 0, 'Azul']]);
  });

  it('borda: uma opção PADRÃO viva SEM nome manda o nome da linha armazenada; com a linha também em branco, o da variante', () => {
    const semNome = vivaDeUmaOpcao('', OPCAO_AZUL_TURQUESA);

    const daLinha = montarTiers(
      args({
        grupos: [grupoDe([tom], [entradaBr('Azul Turquesa ')])],
        filhos: [filhoDe('v-tom')],
        viva: semNome,
      }),
    );
    expect(daLinha.problemas).toEqual([]);
    expect(opcoesDe(daLinha)).toEqual([['v-tom', OPCAO_AZUL_TURQUESA, 'Azul Turquesa']]);

    const daVariante = montarTiers(
      args({
        grupos: [grupoDe([tom], [entradaBr('  ')])],
        filhos: [filhoDe('v-tom')],
        viva: semNome,
      }),
    );
    expect(daVariante.problemas).toEqual([]);
    expect(opcoesDe(daVariante)).toEqual([['v-tom', OPCAO_AZUL_TURQUESA, 'Tom inventado']]);
  });

  it('⛔ consequência: OUTRA variante com o nome da opção viva que a linha já deu a uma variante colide (combinacao-duplicada) — antes, a viva era renomeada e uma gêmea anexada', () => {
    const linhaCustom = entrada({
      variation_id: 0,
      variationOptions: [
        {
          shopee_option_id: 0,
          shopee_option_name: 'Cor inventada',
          arakene_variation_id: ['v-erp'],
        },
      ],
    });
    const r = montarTiers(
      args({
        grupos: [
          grupoDe(
            [variante('v-erp', 'Cor do ERP'), variante('v-xara', 'Cor inventada')],
            [linhaCustom],
          ),
        ],
        filhos: [filhoDe('v-erp'), filhoDe('v-xara')],
        viva: vivaDeUmaOpcao('Cor inventada', 0),
      }),
    );
    expect(motivos(r.problemas)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada]);
  });

  /* ---- the name: live over stored, and each arm of the blank fallback ---- */

  it('⚠️ QUASE-PAR (M1): o nome VIVO vence a linha armazenada — a opção PADRÃO 9632, com a linha ainda em «Nome antigo inventado», é reenviada como «Azul Turquesa»', () => {
    const r = montarTiers(
      args({
        grupos: [grupoDe([tom], [entradaBr('Nome antigo inventado')])],
        filhos: [filhoDe('v-tom')],
        viva: vivaDeUmaOpcao('Azul Turquesa', OPCAO_AZUL_TURQUESA),
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(opcoesDe(r)).toEqual([['v-tom', OPCAO_AZUL_TURQUESA, 'Azul Turquesa']]);
  });

  it('⚠️ PAR: a opção que a árvore viva NÃO tem, ANEXADA numa atualização, manda o nome armazenado da linha — nunca o da variante', () => {
    const duasLinhas = entrada({
      variation_id: VARIACAO_COR_BR,
      variationOptions: [
        {
          shopee_option_id: OPCAO_AZUL_TURQUESA,
          shopee_option_name: 'Azul Turquesa',
          arakene_variation_id: ['v-tom'],
        },
        { shopee_option_id: 6245, shopee_option_name: 'Verde', arakene_variation_id: ['v-outra'] },
      ],
    });
    const r = montarTiers(
      args({
        grupos: [grupoDe([tom, variante('v-outra', 'Outro tom inventado')], [duasLinhas])],
        filhos: [filhoDe('v-tom'), filhoDe('v-outra')],
        viva: vivaDeUmaOpcao('Azul Turquesa', OPCAO_AZUL_TURQUESA),
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(opcoesDe(r)).toEqual([
      ['v-tom', OPCAO_AZUL_TURQUESA, 'Azul Turquesa'],
      ['v-outra', 6245, 'Verde'],
    ]);
  });

  it('borda: sem nome vivo, a linha vale mesmo com a variante FORA do grupo (a posição não pareia ninguém); sem nome nenhum, o branco vai como está', () => {
    const semNome = vivaDeUmaOpcao('', OPCAO_AZUL_TURQUESA);
    const outra = variante('v-outra', 'Cor do ERP');
    const linhaOutra = {
      shopee_option_id: 9700,
      shopee_option_name: 'Opção inventada B',
      arakene_variation_id: ['v-outra'],
    };
    const linhaSumida = {
      shopee_option_id: OPCAO_AZUL_TURQUESA,
      shopee_option_name: 'Azul Turquesa',
      arakene_variation_id: ['v-sumiu'],
    };

    const daLinha = montarTiers(
      args({
        grupos: [
          grupoDe(
            [outra],
            [
              entrada({
                variation_id: VARIACAO_COR_BR,
                variationOptions: [linhaSumida, linhaOutra],
              }),
            ],
          ),
        ],
        filhos: [filhoDe('v-outra')],
        viva: semNome,
      }),
    );
    expect(daLinha.problemas).toEqual([]);
    expect(opcoesDe(daLinha)).toEqual([
      [null, OPCAO_AZUL_TURQUESA, 'Azul Turquesa'],
      ['v-outra', 9700, 'Opção inventada B'],
    ]);

    const emBranco = montarTiers(
      args({
        grupos: [
          grupoDe(
            [outra],
            [entrada({ variation_id: VARIACAO_COR_BR, variationOptions: [linhaOutra] })],
          ),
        ],
        filhos: [filhoDe('v-outra')],
        viva: semNome,
      }),
    );
    expect(emBranco.problemas).toEqual([]);
    expect(opcoesDe(emBranco)).toEqual([
      [null, OPCAO_AZUL_TURQUESA, ''],
      ['v-outra', 9700, 'Opção inventada B'],
    ]);
  });

  /* ---- #1911 P14b (P14a open point 7): a row stored BLANK names nothing ---- */

  describe('#1911 P14b (aberto 7): uma linha armazenada cujo nome dobra para BRANCO conta como sem nome — vai o nome da VARIANTE, em todo braço que autora uma opção', () => {
    const linhaCustom = (shopee_option_name: string) =>
      entrada({
        variation_id: 0,
        variationOptions: [
          { shopee_option_id: 0, shopee_option_name, arakene_variation_id: ['v-tom'] },
        ],
      });

    /** `''`, spaces and an NBSP: all blank AFTER the fold (`trim` strips U+00A0). */
    const BRANCOS = ['', '  ', '\u00a0'] as const;

    it.each(BRANCOS)(
      '⚠️ PAR (criação, PADRÃO): a linha 9632 com nome %j manda «Tom inventado» ao lado do id — nunca o branco',
      (branco) => {
        const r = montarTiers(
          args({
            grupos: [grupoDe([tom], [entradaBr(branco)])],
            filhos: [filhoDe('v-tom')],
            viva: null,
          }),
        );
        expect(r.problemas).toEqual([]);
        expect(opcoesDe(r)).toEqual([['v-tom', OPCAO_AZUL_TURQUESA, 'Tom inventado']]);
      },
    );

    it.each(BRANCOS)(
      '⚠️ PAR (criação, CUSTOM): a linha {0, %j} manda «Tom inventado» — antes recusava dizendo que a variante não tinha nome',
      (branco) => {
        const r = montarTiers(
          args({
            grupos: [grupoDe([tom], [linhaCustom(branco)])],
            filhos: [filhoDe('v-tom')],
            viva: null,
          }),
        );
        expect(r.problemas).toEqual([]);
        expect(opcoesDe(r)).toEqual([['v-tom', 0, 'Tom inventado']]);
      },
    );

    it('⚠️ PAR (init): numa mudança de profundidade, o grupo que não casa é autorado do ERP — a linha em branco manda o nome da variante', () => {
      const viva: ArvoreVivaDoItem = {
        tier_variation: [
          shopeeTierVariationSchema.parse({ name: 'Estampa', option_list: [{ option: 'Lisa' }] }),
        ],
        standardise_tier_variation: null,
        model: [modeloVivo({ model_id: MODELO, tier_index: [0], model_sku: 'TM' })],
      };
      const tam = grupo({
        grupoId: 'g-tam',
        nome: 'Tamanho',
        ordem: 2,
        variacoes: [variante('v-p', 'P')],
        linksVariacoesShopee: null,
      });
      const r = montarTiers(
        args({
          grupos: [grupoDe([tom], [entradaBr('  ')]), tam],
          filhos: [
            filho({
              produtoId: 'p-tom-p',
              variacoesUid: [varianteFakePath('g-cor', 'v-tom'), varianteFakePath('g-tam', 'v-p')],
            }),
          ],
          viva,
        }),
      );
      expect(r.problemas).toEqual([]);
      expect(opcoesDe(r)).toEqual([['v-tom', OPCAO_AZUL_TURQUESA, 'Tom inventado']]);
      const plano = reconciliarModelos({
        montados: r.modelos,
        armazenados: [],
        viva,
        profundidadeNossa: r.tiers.length,
      });
      expect(plano).toMatchObject({ acao: 'init', mudouProfundidade: true });
    });

    it('⚠️ PAR (anexada numa atualização): a segunda linha com nome em BRANCO manda «Outro tom inventado» — a opção viva mantém o seu', () => {
      const duasLinhas = entrada({
        variation_id: VARIACAO_COR_BR,
        variationOptions: [
          {
            shopee_option_id: OPCAO_AZUL_TURQUESA,
            shopee_option_name: 'Azul Turquesa',
            arakene_variation_id: ['v-tom'],
          },
          { shopee_option_id: 6245, shopee_option_name: '', arakene_variation_id: ['v-outra'] },
        ],
      });
      const r = montarTiers(
        args({
          grupos: [grupoDe([tom, variante('v-outra', 'Outro tom inventado')], [duasLinhas])],
          filhos: [filhoDe('v-tom'), filhoDe('v-outra')],
          viva: vivaDeUmaOpcao('Azul Turquesa', OPCAO_AZUL_TURQUESA),
        }),
      );
      expect(r.problemas).toEqual([]);
      expect(opcoesDe(r)).toEqual([
        ['v-tom', OPCAO_AZUL_TURQUESA, 'Azul Turquesa'],
        ['v-outra', 6245, 'Outro tom inventado'],
      ]);
    });

    it("⛔ QUASE (escopo da dobra): o nome da VARIANTE também dobra — ' Tom inventado ' vai como 'Tom inventado'", () => {
      for (const links of [[entradaBr('')], [linhaCustom('')]]) {
        const r = montarTiers(
          args({
            grupos: [grupoDe([variante('v-tom', ' Tom inventado ')], links)],
            filhos: [filhoDe('v-tom')],
            viva: null,
          }),
        );
        expect(r.problemas).toEqual([]);
        expect(opcoesDe(r)[0]?.[2]).toBe('Tom inventado');
      }
    });

    it("⛔ QUASE (escopo da dobra): uma linha '.' é um NOME — vai '.', nunca o da variante (PADRÃO e CUSTOM)", () => {
      const padrao = montarTiers(
        args({
          grupos: [grupoDe([tom], [entradaBr('.')])],
          filhos: [filhoDe('v-tom')],
          viva: null,
        }),
      );
      expect(opcoesDe(padrao)).toEqual([['v-tom', OPCAO_AZUL_TURQUESA, '.']]);
      const custom = montarTiers(
        args({
          grupos: [grupoDe([tom], [linhaCustom('.')])],
          filhos: [filhoDe('v-tom')],
          viva: null,
        }),
      );
      expect(custom.problemas).toEqual([]);
      expect(opcoesDe(custom)).toEqual([['v-tom', 0, '.']]);
    });

    it('⛔ QUASE (escopo da dobra): uma linha só com U+200B (largura zero — o trim NÃO o tira) é um nome e vai como está', () => {
      const r = montarTiers(
        args({
          grupos: [grupoDe([tom], [entradaBr('\u200b')])],
          filhos: [filhoDe('v-tom')],
          viva: null,
        }),
      );
      expect(opcoesDe(r)).toEqual([['v-tom', OPCAO_AZUL_TURQUESA, '\u200b']]);
    });

    it('⛔ QUASE: linha CUSTOM em branco E variante sem nome — continua recusada, agora com a frase verdadeira (a variante não tem nome)', () => {
      const r = montarTiers(
        args({
          grupos: [grupoDe([variante('v-tom', '  ')], [linhaCustom('')])],
          filhos: [filhoDe('v-tom')],
          viva: null,
        }),
      );
      expect(r.problemas).toEqual([
        {
          campo: 'standardise_tier_variation',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.opcoesDemais,
          mensagem:
            'A variante v-tom do grupo "Cor" não tem nome, e uma opção personalizada leva o nome da variante — dê um nome a ela em Variações.',
        },
      ]);
    });

    it('caracterização (inalterada): linha PADRÃO em branco E variante sem nome — o branco vai ao lado do id, sem recusa (o nome de uma opção padrão nunca é conferido)', () => {
      const r = montarTiers(
        args({
          grupos: [grupoDe([variante('v-tom', '  ')], [entradaBr('')])],
          filhos: [filhoDe('v-tom')],
          viva: null,
        }),
      );
      expect(r.problemas).toEqual([]);
      expect(opcoesDe(r)).toEqual([['v-tom', OPCAO_AZUL_TURQUESA, '']]);
    });
  });

  /* ---- which row and which variante a live option stands for -------------- */

  it('⛔ QUASE: uma opção PADRÃO viva SEM linha nunca casa pelo nome da variante — a variante homônima é recusada (variacao-sem-vinculo)', () => {
    const r = montarTiers(
      args({
        grupos: [
          grupoDe(
            [variante('v-homonima', 'Azul Turquesa')],
            [entrada({ variation_id: VARIACAO_COR_BR, variationOptions: [] })],
          ),
        ],
        filhos: [filhoDe('v-homonima')],
        viva: vivaDeUmaOpcao('Azul Turquesa', OPCAO_AZUL_TURQUESA),
      }),
    );
    expect(r.problemas[0]?.motivo).toBe(MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo);
    expect(r.modelos).toEqual([]);
  });

  it('⛔ QUASE: uma opção CUSTOM viva nunca casa por NOME com uma linha NÃO-ZERO — fica no índice dela, sem variante, e a linha vira uma opção anexada', () => {
    const linhaNaoZero = entrada({
      variation_id: 0,
      variationOptions: [
        {
          shopee_option_id: 5,
          shopee_option_name: 'Cor inventada',
          arakene_variation_id: ['v-erp'],
        },
      ],
    });
    const r = montarTiers(
      args({
        grupos: [grupoDe([variante('v-erp', 'Cor do ERP')], [linhaNaoZero])],
        filhos: [filhoDe('v-erp')],
        viva: vivaDeUmaOpcao('Cor inventada', 0),
      }),
    );
    expect(opcoesDe(r)).toEqual([
      [null, 0, 'Cor inventada'],
      ['v-erp', 5, 'Cor inventada'],
    ]);
  });

  it('⚠️ PAR: duas linhas {0, …} que dobram para o mesmo nome — a publicação lê a PRIMEIRA, a mesma do rung 1 da importação', () => {
    const duasLinhas = entrada({
      variation_id: 0,
      variationOptions: [
        {
          shopee_option_id: 0,
          shopee_option_name: 'Cor inventada ',
          arakene_variation_id: ['v-primeira'],
        },
        {
          shopee_option_id: 0,
          shopee_option_name: 'Cor inventada',
          arakene_variation_id: ['v-segunda'],
        },
      ],
    });
    const r = montarTiers(
      args({
        grupos: [
          grupoDe(
            [variante('v-primeira', 'Primeira do ERP'), variante('v-segunda', 'Segunda do ERP')],
            [duasLinhas],
          ),
        ],
        filhos: [filhoDe('v-primeira')],
        viva: vivaDeUmaOpcao('Cor inventada', 0),
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(opcoesDe(r)).toEqual([['v-primeira', 0, 'Cor inventada']]);
  });

  it('⛔ QUASE: uma linha {0, …} PENDURADA não impede a opção custom de casar pelo nome da variante — como o rung 2 da importação', () => {
    const pendurada = entrada({
      variation_id: 0,
      variationOptions: [
        {
          shopee_option_id: 0,
          shopee_option_name: 'Cor inventada',
          arakene_variation_id: ['v-sumiu'],
        },
      ],
    });
    const r = montarTiers(
      args({
        grupos: [grupoDe([variante('v-nome', 'Cor inventada')], [pendurada])],
        filhos: [filhoDe('v-nome')],
        viva: vivaDeUmaOpcao('Cor inventada', 0),
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(opcoesDe(r)).toEqual([['v-nome', 0, 'Cor inventada']]);
  });

  it("⛔ QUASE: a linha {0, 'cor inventada'} (a CAIXA) e a linha {0, 'Cor  inventada'} (DOIS espaços DENTRO) NÃO pareiam a opção viva 'Cor inventada' — a viva fica sem variante e a variante é anexada com o nome da linha", () => {
    for (const nomeDaLinha of ['cor inventada', 'Cor  inventada']) {
      const r = montarTiers(
        args({
          grupos: [
            grupoDe(
              [variante('v-erp', 'Cor do ERP')],
              [
                entrada({
                  variation_id: 0,
                  variationOptions: [
                    {
                      shopee_option_id: 0,
                      shopee_option_name: nomeDaLinha,
                      arakene_variation_id: ['v-erp'],
                    },
                  ],
                }),
              ],
            ),
          ],
          filhos: [filhoDe('v-erp')],
          viva: vivaDeUmaOpcao('Cor inventada', 0),
        }),
      );
      expect(opcoesDe(r), nomeDaLinha).toEqual([
        [null, 0, 'Cor inventada'],
        ['v-erp', 0, nomeDaLinha],
      ]);
    }
  });

  it('⚠️ PAR: a LINHA vence a variante homônima — a viva «Cor inventada» fica com v-erp, nunca com a outra variante de mesmo nome', () => {
    const r = montarTiers(
      args({
        grupos: [
          grupoDe(
            [variante('v-xara', 'Cor inventada'), variante('v-erp', 'Cor do ERP')],
            [
              entrada({
                variation_id: 0,
                variationOptions: [
                  {
                    shopee_option_id: 0,
                    shopee_option_name: 'Cor inventada',
                    arakene_variation_id: ['v-erp'],
                  },
                ],
              }),
            ],
          ),
        ],
        filhos: [filhoDe('v-erp')],
        viva: vivaDeUmaOpcao('Cor inventada', 0),
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(opcoesDe(r)).toEqual([['v-erp', 0, 'Cor inventada']]);
  });

  it('⚠️ o formato da captura: um tier PADRÃO vivo com uma opção de id 0, ligada por uma linha {0, …} sob um variation_id NÃO-ZERO — pareia pela linha, e o filho fica no índice dela', () => {
    const viva: ArvoreVivaDoItem = {
      tier_variation: [
        shopeeTierVariationSchema.parse({
          name: 'Cor',
          option_list: [{ option: 'Azul Turquesa' }, { option: 'Cor inventada' }],
        }),
      ],
      standardise_tier_variation: [
        shopeeStandardiseTierVariationSchema.parse({
          variation_id: VARIACAO_COR_BR,
          variation_name: 'Cor',
          variation_option_list: [
            { variation_option_id: OPCAO_AZUL_TURQUESA, variation_option_name: 'Azul Turquesa' },
            { variation_option_id: 0, variation_option_name: 'Cor inventada' },
          ],
        }),
      ],
      model: [
        modeloVivo({ model_id: MODELO - 1, tier_index: [0], model_sku: 'AT' }),
        modeloVivo({ model_id: MODELO, tier_index: [1], model_sku: 'TM' }),
      ],
    };
    const r = montarTiers(
      args({
        grupos: [
          grupoDe(
            [variante('v-erp', 'Cor do ERP')],
            [
              entrada({
                variation_id: VARIACAO_COR_BR,
                variationOptions: [
                  {
                    shopee_option_id: 0,
                    shopee_option_name: 'Cor inventada',
                    arakene_variation_id: ['v-erp'],
                  },
                ],
              }),
            ],
          ),
        ],
        filhos: [filhoDe('v-erp')],
        viva,
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(opcoesDe(r)).toEqual([
      [null, OPCAO_AZUL_TURQUESA, 'Azul Turquesa'],
      ['v-erp', 0, 'Cor inventada'],
    ]);
    expect(r.modelos.map((m) => m.tier_index)).toEqual([[1]]);
  });

  /* ---- a row binding several variantes: the one a child of THIS publish uses */

  describe('uma linha que liga VÁRIAS variantes: vale a que um filho desta publicação usa', () => {
    const DUAS_VARIANTES = [variante('v-um', 'Um inventado'), variante('v-dois', 'Dois inventado')];
    const linhaComDuas = entrada({
      variation_id: VARIACAO_COR_BR,
      variationOptions: [
        {
          shopee_option_id: OPCAO_AZUL_TURQUESA,
          shopee_option_name: 'Azul Turquesa',
          arakene_variation_id: ['v-um', 'v-dois'],
        },
      ],
    });

    it('⚠️ PAR: o filho deste produto usa a SEGUNDA variante da linha — o republish segue, com o nome vivo, sem gêmea e sem mudar nada', () => {
      const viva = vivaDeUmaOpcao('Azul Turquesa', OPCAO_AZUL_TURQUESA);
      const r = montarTiers(
        args({
          grupos: [grupoDe(DUAS_VARIANTES, [linhaComDuas])],
          filhos: [filhoDe('v-dois')],
          viva,
        }),
      );
      expect(r.problemas).toEqual([]);
      expect(opcoesDe(r)).toEqual([['v-dois', OPCAO_AZUL_TURQUESA, 'Azul Turquesa']]);
      expect(r.modelos.map((m) => m.tier_index)).toEqual([[0]]);
      const plano = reconciliarModelos({
        montados: r.modelos,
        armazenados: [
          {
            produtoId: 'p-v-dois',
            linkDocId: 'l-v-dois',
            modelId: MODELO,
            modelSku: 'TM',
            tierIndex: [0],
          },
        ],
        viva,
        profundidadeNossa: r.tiers.length,
      });
      expect(plano.acao).toBe('nenhuma');
    });

    it('⛔ QUASE: DOIS filhos, um em cada variante da mesma linha, caem na mesma opção — combinacao-duplicada', () => {
      const r = montarTiers(
        args({
          grupos: [grupoDe(DUAS_VARIANTES, [linhaComDuas])],
          filhos: [filhoDe('v-um'), filhoDe('v-dois')],
          viva: vivaDeUmaOpcao('Azul Turquesa', OPCAO_AZUL_TURQUESA),
        }),
      );
      expect(motivos(r.problemas)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada]);
    });

    it('sem filho em nenhuma variante da linha, a opção viva continua ligada à PRIMEIRA, na ordem do grupo', () => {
      const r = montarTiers(
        args({
          grupos: [
            grupoDe(
              [...DUAS_VARIANTES, variante('v-tres', 'Tres inventado')],
              [
                entrada({
                  variation_id: VARIACAO_COR_BR,
                  variationOptions: [
                    {
                      shopee_option_id: OPCAO_AZUL_TURQUESA,
                      shopee_option_name: 'Azul Turquesa',
                      arakene_variation_id: ['v-dois', 'v-um'],
                    },
                    {
                      shopee_option_id: 6245,
                      shopee_option_name: 'Verde',
                      arakene_variation_id: ['v-tres'],
                    },
                  ],
                }),
              ],
            ),
          ],
          filhos: [filhoDe('v-tres')],
          viva: vivaDeUmaOpcao('Azul Turquesa', OPCAO_AZUL_TURQUESA),
        }),
      );
      expect(r.problemas).toEqual([]);
      expect(opcoesDe(r)).toEqual([
        ['v-um', OPCAO_AZUL_TURQUESA, 'Azul Turquesa'],
        ['v-tres', 6245, 'Verde'],
      ]);
    });

    it('a linha CUSTOM também: o filho da segunda variante fica com a opção viva, sem gêmea e sem renomear', () => {
      const r = montarTiers(
        args({
          grupos: [
            grupoDe(DUAS_VARIANTES, [
              entrada({
                variation_id: 0,
                variationOptions: [
                  {
                    shopee_option_id: 0,
                    shopee_option_name: 'Cor inventada',
                    arakene_variation_id: ['v-um', 'v-dois'],
                  },
                ],
              }),
            ]),
          ],
          filhos: [filhoDe('v-dois')],
          viva: vivaDeUmaOpcao('Cor inventada', 0),
        }),
      );
      expect(r.problemas).toEqual([]);
      expect(opcoesDe(r)).toEqual([['v-dois', 0, 'Cor inventada']]);
      expect(r.modelos.map((m) => m.tier_index)).toEqual([[0]]);
    });
  });

  /* ---- two live custom options on ONE variante: the key the name fold lost - */

  describe('duas opções CUSTOM vivas na MESMA variante: a colisão que a chave de nome não vê', () => {
    // A custom option is keyed by the name SENT, and M1 sends each live option's own,
    // so the names differ. Unrefused, a full grid fails in the client (repeated
    // `tier_index`, after `update_item`), and a free coordinate reaches Shopee.
    it('⛔ duas opções CUSTOM vivas que caem na MESMA variante (a linha liga a 1ª, o nome liga a 2ª) continuam colidindo (combinacao-duplicada) — o modelo da 2ª não pode cair na coordenada da 1ª', () => {
      const linhaDaPrimeira = entrada({
        variation_id: 0,
        variationOptions: [
          {
            shopee_option_id: 0,
            shopee_option_name: 'Opção A inventada',
            arakene_variation_id: ['v-erp'],
          },
        ],
      });
      const r = montarTiers(
        args({
          grupos: [grupoDe([variante('v-erp', 'Opção B inventada')], [linhaDaPrimeira])],
          filhos: [filhoDe('v-erp')],
          viva: arvore(
            ['Opção A inventada', 'Opção B inventada'],
            [
              modeloVivo({ model_id: MODELO - 1, tier_index: [0], model_sku: 'A' }),
              modeloVivo({ model_id: MODELO, tier_index: [1], model_sku: 'TM' }),
            ],
          ),
        }),
      );
      expect(motivos(r.problemas)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada]);
    });

    it('⛔ duas LINHAS custom ligam duas opções vivas à MESMA variante — combinacao-duplicada', () => {
      const duasLinhas = entrada({
        variation_id: 0,
        variationOptions: [
          {
            shopee_option_id: 0,
            shopee_option_name: 'Opção A inventada',
            arakene_variation_id: ['v-erp'],
          },
          {
            shopee_option_id: 0,
            shopee_option_name: 'Opção B inventada',
            arakene_variation_id: ['v-erp'],
          },
        ],
      });
      const r = montarTiers(
        args({
          grupos: [grupoDe([variante('v-erp', 'Cor do ERP')], [duasLinhas])],
          filhos: [filhoDe('v-erp')],
          viva: arvore(
            ['Opção A inventada', 'Opção B inventada'],
            [
              modeloVivo({ model_id: MODELO - 1, tier_index: [0], model_sku: 'A' }),
              modeloVivo({ model_id: MODELO, tier_index: [1], model_sku: 'TM' }),
            ],
          ),
        }),
      );
      expect(motivos(r.problemas)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada]);
    });

    it('⛔ duas opções CUSTOM vivas na MESMA variante, grade ESPARSA de 2 níveis: o modelo da 2ª iria para uma coordenada LIVRE, que o cliente deixa passar — combinacao-duplicada', () => {
      const viva: ArvoreVivaDoItem = {
        tier_variation: [
          shopeeTierVariationSchema.parse({
            name: 'Cor',
            option_list: [{ option: 'Opção A inventada' }, { option: 'Opção B inventada' }],
          }),
          shopeeTierVariationSchema.parse({
            name: 'Tamanho',
            option_list: [{ option: 'P' }, { option: 'M' }],
          }),
        ],
        standardise_tier_variation: null,
        model: [
          modeloVivo({ model_id: MODEL_ID, tier_index: [0, 0], model_sku: 'SKU-P' }),
          modeloVivo({ model_id: MODEL_ID + 1, tier_index: [1, 1], model_sku: 'SKU-M' }),
        ],
      };
      const grupos = [
        grupo({
          grupoId: 'g-cor',
          variacoes: [variante('v-erp', 'Opção B inventada')],
          linksVariacoesShopee: [
            entrada({
              variationOptions: [
                {
                  shopee_option_id: 0,
                  shopee_option_name: 'Opção A inventada',
                  arakene_variation_id: ['v-erp'],
                },
              ],
            }),
          ],
        }),
        grupo({
          grupoId: 'g-tam',
          nome: 'Tamanho',
          ordem: 2,
          variacoes: [variante('t-p', 'P'), variante('t-m', 'M', 2)],
          linksVariacoesShopee: null,
        }),
      ];
      const filhos = [
        filho({
          produtoId: 'p-p',
          sku: 'SKU-P',
          variacoesUid: [varianteFakePath('g-cor', 'v-erp'), varianteFakePath('g-tam', 't-p')],
        }),
        filho({
          produtoId: 'p-m',
          sku: 'SKU-M',
          variacoesUid: [varianteFakePath('g-cor', 'v-erp'), varianteFakePath('g-tam', 't-m')],
        }),
      ];
      const r = montarTiers(args({ grupos, filhos, viva }));
      expect(motivos(r.problemas)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.combinacaoDuplicada]);
    });

    it('⚠️ QUASE: duas variantes de MESMO nome, cada uma com a SUA linha, NÃO colidem — a chave é o id da variante, nunca o nome', () => {
      const viva = arvore(
        ['Opção A inventada', 'Opção B inventada'],
        [
          modeloVivo({ model_id: MODELO - 1, tier_index: [0], model_sku: 'A' }),
          modeloVivo({ model_id: MODELO, tier_index: [1], model_sku: 'B' }),
        ],
      );
      const r = montarTiers(
        args({
          grupos: [
            grupoDe(
              [
                variante('v-um', 'Mesmo nome inventado'),
                variante('v-dois', 'Mesmo nome inventado'),
              ],
              [
                entrada({
                  variation_id: 0,
                  variationOptions: [
                    {
                      shopee_option_id: 0,
                      shopee_option_name: 'Opção A inventada',
                      arakene_variation_id: ['v-um'],
                    },
                    {
                      shopee_option_id: 0,
                      shopee_option_name: 'Opção B inventada',
                      arakene_variation_id: ['v-dois'],
                    },
                  ],
                }),
              ],
            ),
          ],
          filhos: [
            filho({
              produtoId: 'p-um',
              sku: 'A',
              linkDocId: 'l-um',
              variacoesUid: [varianteFakePath('g-cor', 'v-um')],
            }),
            filho({
              produtoId: 'p-dois',
              sku: 'B',
              linkDocId: 'l-dois',
              variacoesUid: [varianteFakePath('g-cor', 'v-dois')],
            }),
          ],
          viva,
        }),
      );
      expect(r.problemas).toEqual([]);
      const plano = reconciliarModelos({
        montados: r.modelos,
        armazenados: [],
        viva,
        profundidadeNossa: r.tiers.length,
      });
      expect(plano.acao).toBe('nenhuma');
    });
  });

  /* ---- a Seller Centre rename, and what the next update does with it ------- */

  it('⚠️ opção personalizada renomeada na Seller Centre: sem variante de mesmo nome o update reanexa o nome ANTIGO e move o modelo; a variante renomeada ANTES pareia e nada muda', () => {
    const linhaAntiga = {
      shopee_option_id: 0,
      shopee_option_name: 'Nome antigo inventado',
      arakene_variation_id: ['v-erp'],
    };
    const viva = arvore(
      ['Nome novo inventado'],
      [modeloVivo({ model_id: MODEL_ID, tier_index: [0] })],
    );
    const publicar = (nomeDaVariante: string) => {
      const montagem = montarTiers(
        args({
          grupos: [
            grupo({
              grupoId: 'g',
              variacoes: [variante('v-erp', nomeDaVariante)],
              linksVariacoesShopee: [entrada({ variationOptions: [linhaAntiga] })],
            }),
          ],
          filhos: [
            filho({
              produtoId: 'p',
              variacoesUid: [varianteFakePath('g', 'v-erp')],
              linkModelId: MODEL_ID,
              tierIndexArmazenado: [0],
            }),
          ],
          viva,
        }),
      );
      const plano = reconciliarModelos({
        montados: montagem.modelos,
        armazenados: [
          { produtoId: 'p', linkDocId: 'l', modelId: MODEL_ID, modelSku: null, tierIndex: [0] },
        ],
        viva,
        profundidadeNossa: montagem.tiers.length,
      });
      return {
        nomes: montagem.tiers[0]?.opcoes.map((o) => o.variation_option_name),
        modelList: plano.modelList,
        acao: plano.acao,
      };
    };
    expect(publicar('Cor do ERP')).toEqual({
      nomes: ['Nome novo inventado', 'Nome antigo inventado'],
      modelList: [{ model_id: MODEL_ID, tier_index: [1] }],
      acao: 'update',
    });
    expect(publicar('Nome novo inventado')).toEqual({
      nomes: ['Nome novo inventado'],
      modelList: [{ model_id: MODEL_ID, tier_index: [0] }],
      acao: 'nenhuma',
    });
  });

  it('⚠️ PAR (#1911 P14b, Q1): a MESMA renomeação na Seller Centre, com a linha {0, antiga} numa entrada PADRÃO casada pelo nome com o tier custom ⇒ RECUSADA pela frase do anexo — a variante com o nome ANTIGO (o ERP intocado) e a renomeada no ERP; o ponto aberto 6 segue sem guarda só para a entrada CUSTOM', () => {
    const viva = arvore(
      ['Nome novo inventado'],
      [modeloVivo({ model_id: MODEL_ID, tier_index: [0] })],
    );
    const publicar = (nomeDaVariante: string) =>
      montarTiers(
        args({
          grupos: [
            grupo({
              grupoId: 'g',
              variacoes: [variante('v-erp', nomeDaVariante)],
              linksVariacoesShopee: [
                entrada({
                  variation_id: 88,
                  variationOptions: [
                    {
                      shopee_option_id: 0,
                      shopee_option_name: 'Nome antigo inventado',
                      arakene_variation_id: ['v-erp'],
                    },
                  ],
                }),
              ],
            }),
          ],
          filhos: [
            filho({
              produtoId: 'p',
              variacoesUid: [varianteFakePath('g', 'v-erp')],
              linkModelId: MODEL_ID,
              tierIndexArmazenado: [0],
            }),
          ],
          viva,
        }),
      );
    for (const nome of ['Nome antigo inventado', 'Cor do ERP']) {
      const r = publicar(nome);
      expect(r.problemas, nome).toEqual([
        {
          campo: 'standardise_tier_variation',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          mensagem: TEXTO_ANEXO_SOB_PADRAO(nome, 'Cor', 'Cor', 88),
        },
        {
          campo: 'model',
          motivo: MOTIVO_PUBLICACAO_BLOQUEADA.variacaoSemVinculo,
          mensagem: 'A variação p não tem posição no grupo "Cor" e o modelo não pode ser colocado.',
        },
      ]);
      expect(
        r.tiers[0]?.opcoes.map((o) => o.variation_option_name),
        nome,
      ).toEqual(['Nome novo inventado']);
    }
    // ⛔ The variante renamed to the NEW name pairs by it: nothing refused, nothing moves.
    expect(publicar('Nome novo inventado').problemas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2e) #1911 batch-A — the NAME bands, checked BEFORE anything is sent      */
/* -------------------------------------------------------------------------- */

describe('montarTiers — #1911 batch-A: os nomes que a publicação AUTORA são conferidos contra a faixa da categoria', () => {
  const BANDA_TIER = { min: 1, max: 14 } as const;
  const BANDA_OPCAO = { min: 1, max: 20 } as const;
  const AZUL = MODEL_ID + 1;

  function publicar(
    nomeDoGrupo: string,
    nomesDasVariantes: readonly string[],
    parcial: Partial<ArgsMontarTiers> = {},
  ) {
    const variacoes = nomesDasVariantes.map((nome, i) => variante(`v-${String(i)}`, nome));
    return montarTiers(
      args({
        grupos: [
          grupo({ grupoId: 'g-x', nome: nomeDoGrupo, variacoes, linksVariacoesShopee: null }),
        ],
        filhos: variacoes.map((v, i) =>
          filho({
            produtoId: `p-${String(i)}`,
            variacoesUid: [varianteFakePath('g-x', v.varianteId)],
          }),
        ),
        bandaNomeDoTier: BANDA_TIER,
        bandaNomeDaOpcao: BANDA_OPCAO,
        ...parcial,
      }),
    );
  }

  const recusa = (mensagem: string) => ({
    campo: 'standardise_tier_variation',
    motivo: MOTIVO_PUBLICACAO_BLOQUEADA.opcoesDemais,
    mensagem,
  });

  it("um tier personalizado 'Tamanho do Calçado' (18) na faixa 1..14 ⇒ RECUSADO opcoes-demais, nunca truncado", () => {
    const r = publicar('Tamanho do Calçado', ['P']);
    expect(r.problemas).toEqual([
      recusa(
        'O nome do tier "Tamanho do Calçado" tem 18 caracteres, fora da faixa da categoria (1..14) — nunca truncado; encurte o nome em Variações.',
      ),
    ]);
  });

  it("⚠️ QUASE: 14 caracteres passam — e o nome é medido COMO ENVIADO ('  Tamanho de Pés ' vai como 14)", () => {
    for (const nome of ['Tamanho de Pés', '  Tamanho de Pés ']) {
      const r = publicar(nome, ['P']);
      expect(r.problemas, nome).toEqual([]);
      expect(r.tiers[0]!.variation_name, nome).toBe('Tamanho de Pés');
    }
  });

  it('uma opção de 21 caracteres na faixa 1..20 ⇒ RECUSADA; ⚠️ QUASE: a de 20 passa', () => {
    const r = publicar('Cor', ['Azul Marinho Profundo', 'Verde Musgo Profundo']);
    expect(r.problemas).toEqual([
      recusa(
        'A opção "Azul Marinho Profundo" do grupo "Cor" tem 21 caracteres, fora da faixa da categoria (1..20) — nunca truncado; encurte o nome em Variações.',
      ),
    ]);
  });

  it('⚠️ QUASE: sem faixa declarada (null) nenhum comprimento é recusado', () => {
    const r = publicar('Tamanho do Calçado', ['Azul Marinho Profundo'], {
      bandaNomeDoTier: null,
      bandaNomeDaOpcao: null,
    });
    expect(r.problemas).toEqual([]);
  });

  it('um nome EM BRANCO é recusado com OU sem faixa — nosso cliente o recusaria só DEPOIS do add_item', () => {
    for (const bandas of [
      { bandaNomeDoTier: BANDA_TIER, bandaNomeDaOpcao: BANDA_OPCAO },
      { bandaNomeDoTier: null, bandaNomeDaOpcao: null },
    ]) {
      const r = publicar('   ', ['  '], bandas);
      expect(r.problemas).toEqual([
        recusa(
          'O grupo g-x não tem nome, e um tier personalizado leva o nome do grupo — dê um nome a ele em Variações.',
        ),
        recusa(
          'A variante v-0 do grupo "   " não tem nome, e uma opção personalizada leva o nome da variante — dê um nome a ela em Variações.',
        ),
      ]);
    }
  });

  it('⛔ o que o anúncio JÁ tem não é conferido: o tier casado e as opções vivas longas passam; só a opção NOVA longa é recusada', () => {
    const arvore: ArvoreVivaDoItem = {
      tier_variation: [
        shopeeTierVariationSchema.parse({
          name: 'Tamanho do Calçado',
          option_list: [{ option: 'Azul Marinho Profundo' }],
        }),
      ],
      standardise_tier_variation: null,
      model: [modeloVivo({ model_id: AZUL, tier_index: [0] })],
    };
    const variacoes = [
      variante('v-held', 'Azul Marinho Profundo'),
      variante('v-nova', 'Vermelho Sangue Escuro'),
    ];
    const grupos = [
      grupo({ grupoId: 'g-x', nome: 'Tamanho do Calçado', variacoes, linksVariacoesShopee: null }),
    ];
    const comBandas = { bandaNomeDoTier: BANDA_TIER, bandaNomeDaOpcao: BANDA_OPCAO };

    const soAViva = montarTiers(
      args({
        grupos,
        filhos: [filho({ produtoId: 'p-held', variacoesUid: [varianteFakePath('g-x', 'v-held')] })],
        viva: arvore,
        ...comBandas,
      }),
    );
    expect(soAViva.problemas).toEqual([]);

    const comANova = montarTiers(
      args({
        grupos,
        filhos: [
          filho({ produtoId: 'p-held', variacoesUid: [varianteFakePath('g-x', 'v-held')] }),
          filho({ produtoId: 'p-nova', variacoesUid: [varianteFakePath('g-x', 'v-nova')] }),
        ],
        viva: arvore,
        ...comBandas,
      }),
    );
    expect(comANova.problemas).toEqual([
      recusa(
        'A opção "Vermelho Sangue Escuro" do grupo "Tamanho do Calçado" tem 22 caracteres, fora da faixa da categoria (1..20) — nunca truncado; encurte o nome em Variações.',
      ),
    ]);
  });

  it('⛔ o nome de uma opção PADRÃO é da Shopee: nunca conferido', () => {
    const r = montarTiers(
      args({
        grupos: [
          grupo({
            grupoId: 'g-x',
            nome: 'Cor',
            variacoes: [variante('v-0', 'Azul')],
            linksVariacoesShopee: [
              entrada({
                variation_id: 77,
                variationOptions: [
                  {
                    shopee_option_id: 5,
                    shopee_option_name: 'Azul Marinho Profundo Escuro',
                    arakene_variation_id: ['v-0'],
                  },
                ],
              }),
            ],
          }),
        ],
        filhos: [filho({ produtoId: 'p-0', variacoesUid: [varianteFakePath('g-x', 'v-0')] })],
        bandaNomeDoTier: { min: 1, max: 1 },
        bandaNomeDaOpcao: { min: 1, max: 1 },
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(r.tiers[0]!.variation_name).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) the three caps — the measured one included                            */
/* -------------------------------------------------------------------------- */

describe('montarTiers — os três limites do fio', () => {
  function comNOpcoes(n: number): ArgsMontarTiers {
    const variacoes = Array.from({ length: n }, (_, i) =>
      variante(`v-${String(i)}`, `Cor ${String(i)}`),
    );
    return args({
      grupos: [grupo({ grupoId: 'g-cor', variacoes })],
      filhos: variacoes.map((v, i) =>
        filho({
          produtoId: `p-${String(i)}`,
          variacoesUid: [varianteFakePath('g-cor', v.varianteId)],
        }),
      ),
    });
  }

  it('50 opções em um tier são ACEITAS — o limite medido na sandbox é 50, nunca 20', () => {
    expect(SHOPEE_TIER_MAX_OPTIONS).toBe(50);
    const r = montarTiers(comNOpcoes(SHOPEE_TIER_MAX_OPTIONS));
    expect(motivos(r.problemas)).not.toContain(MOTIVO_PUBLICACAO_BLOQUEADA.opcoesDemais);
    expect(r.tiers[0]!.opcoes).toHaveLength(50);
  });

  it('51 opções viram opcoes-demais com a contagem', () => {
    const r = montarTiers(comNOpcoes(SHOPEE_TIER_MAX_OPTIONS + 1));
    const demais = r.problemas.filter((p) => p.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.opcoesDemais);
    expect(demais.length).toBeGreaterThan(0);
    expect(demais.some((p) => p.mensagem.includes('51'))).toBe(true);
  });

  it('51 modelos viram opcoes-demais com a contagem', () => {
    // 51 modelos em dois tiers (26 × 2 = 52 combinações; usamos 51 filhos).
    const cores = Array.from({ length: 26 }, (_, i) =>
      variante(`v-c${String(i)}`, `C${String(i)}`),
    );
    const tams = [variante('v-p', 'P'), variante('v-m', 'M')];
    const filhos: FilhoParaPublicar[] = [];
    for (const cor of cores) {
      for (const tam of tams) {
        if (filhos.length === SHOPEE_MODEL_MAX_PER_ITEM + 1) break;
        filhos.push(
          filho({
            produtoId: `p-${cor.varianteId}-${tam.varianteId}`,
            variacoesUid: [
              varianteFakePath('g-cor', cor.varianteId),
              varianteFakePath('g-tam', tam.varianteId),
            ],
          }),
        );
      }
    }
    const r = montarTiers(
      args({
        grupos: [
          grupo({ grupoId: 'g-cor', variacoes: cores }),
          grupo({ grupoId: 'g-tam', nome: 'Tamanho', ordem: 2, variacoes: tams }),
        ],
        filhos,
      }),
    );
    expect(filhos).toHaveLength(51);
    const demais = r.problemas.filter((p) => p.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.opcoesDemais);
    expect(demais.some((p) => p.mensagem.includes('51'))).toBe(true);
  });

  it('3 grupos viram opcoes-demais', () => {
    const grupos = ['a', 'b', 'c'].map((s) =>
      grupo({
        grupoId: `g-${s}`,
        nome: s.toUpperCase(),
        ordem: 1,
        variacoes: [variante(`v-${s}`, s)],
      }),
    );
    const r = montarTiers(
      args({
        grupos,
        filhos: [
          filho({
            produtoId: 'p-1',
            variacoesUid: grupos.map((g) => varianteFakePath(g.grupoId, `v-${g.grupoId.slice(2)}`)),
          }),
        ],
      }),
    );
    expect(motivos(r.problemas)).toContain(MOTIVO_PUBLICACAO_BLOQUEADA.opcoesDemais);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) the stock band — O3                                                    */
/* -------------------------------------------------------------------------- */

describe('montarTiers — a faixa de estoque da loja (medida 2026-09-17)', () => {
  const um = grupo({ grupoId: 'g-cor', variacoes: [variante('v-azul', 'Azul')] });
  function comEstoque(estoque: number, banda: { min: number | null; max: number | null } | null) {
    return montarTiers(
      args({
        grupos: [um],
        bandaDeEstoque: banda,
        filhos: [
          filho({
            produtoId: 'p-1',
            estoque,
            variacoesUid: [varianteFakePath('g-cor', 'v-azul')],
          }),
        ],
      }),
    );
  }

  it('estoque abaixo do mínimo vira problema nomeando a faixa — nunca clampado para CIMA', () => {
    const r = comEstoque(1, { min: 2, max: 1_000_000 });
    expect(motivos(r.problemas)).toEqual([MOTIVO_PUBLICACAO_BLOQUEADA.estoqueAbaixoDoMinimo]);
    expect(r.problemas[0]!.mensagem).toContain('2');
    expect(r.modelos).toEqual([]);
  });

  it('estoque acima do máximo é clampado para BAIXO', () => {
    const r = comEstoque(5_000, { min: 2, max: 1_000 });
    expect(r.problemas).toEqual([]);
    expect(r.modelos[0]!.seller_stock).toEqual([{ stock: 1_000 }]);
  });

  it('sem faixa declarada nada é clampado e nada é recusado', () => {
    const r = comEstoque(0, null);
    expect(r.problemas).toEqual([]);
    expect(r.modelos[0]!.seller_stock).toEqual([{ stock: 0 }]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) option images — tier 1 only, all or none                              */
/* -------------------------------------------------------------------------- */

describe('fotoDaOpcaoDeTier / imagens de opção', () => {
  const azul = variante('v-azul', 'Azul');

  it('usa a foto PRÓPRIA do primeiro filho que tem uma', () => {
    const propria = foto(null);
    const achada = fotoDaOpcaoDeTier(
      azul,
      'g-cor',
      [
        filho({ produtoId: 'p-0', variacoesUid: [] }),
        filho({
          produtoId: 'p-1',
          variacoesUid: [varianteFakePath('g-cor', 'v-azul')],
          fotos: [propria],
        }),
      ],
      [foto(varianteFakePath('g-cor', 'v-azul'))],
    );
    expect(achada).toBe(propria);
  });

  it('cai para a foto do PAI marcada para a variante', () => {
    const marcada = foto(varianteFakePath('g-cor', 'v-azul'));
    const achada = fotoDaOpcaoDeTier(
      azul,
      'g-cor',
      [filho({ produtoId: 'p-1', variacoesUid: [varianteFakePath('g-cor', 'v-azul')] })],
      [foto(varianteFakePath('g-cor', 'v-outra')), marcada],
    );
    expect(achada).toBe(marcada);
  });

  it('⚠️ QUASE: uma opção sem foto própria NÃO herda a primeira foto do pai', () => {
    const achada = fotoDaOpcaoDeTier(
      azul,
      'g-cor',
      [filho({ produtoId: 'p-1', variacoesUid: [varianteFakePath('g-cor', 'v-azul')] })],
      [foto(null), foto(varianteFakePath('g-outro', 'v-azul'))],
    );
    expect(achada).toBeNull();
  });

  function comImagens(mapa: ReadonlyMap<string, string>, permiteFotos = true) {
    const variacoes = [azul, variante('v-verde', 'Verde')];
    return montarTiers(
      args({
        grupos: [grupo({ grupoId: 'g-cor', permiteFotos, variacoes })],
        imagensDeOpcao: mapa,
        filhos: variacoes.map((v) =>
          filho({
            produtoId: `p-${v.varianteId}`,
            variacoesUid: [varianteFakePath('g-cor', v.varianteId)],
          }),
        ),
      }),
    );
  }

  it('imagens de opção são tudo-ou-nada no tier 1', () => {
    const todas = comImagens(
      new Map([
        [varianteFakePath('g-cor', 'v-azul'), 'img-a'],
        [varianteFakePath('g-cor', 'v-verde'), 'img-v'],
      ]),
    );
    expect(todas.tiers[0]!.opcoes.map((o) => o.image_id)).toEqual(['img-a', 'img-v']);

    const parcial = comImagens(new Map([[varianteFakePath('g-cor', 'v-azul'), 'img-a']]));
    expect(parcial.tiers[0]!.opcoes.map((o) => o.image_id)).toEqual([null, null]);
  });

  it('permiteFotos false não envia image_id em nenhuma opção', () => {
    const r = comImagens(
      new Map([
        [varianteFakePath('g-cor', 'v-azul'), 'img-a'],
        [varianteFakePath('g-cor', 'v-verde'), 'img-v'],
      ]),
      false,
    );
    expect(r.tiers[0]!.opcoes.map((o) => o.image_id)).toEqual([null, null]);
  });

  it('o tier 2 nunca recebe image_id, mesmo com o mapa completo', () => {
    const cor = grupo({ grupoId: 'g-cor', permiteFotos: true, variacoes: [azul] });
    const tam = grupo({
      grupoId: 'g-tam',
      nome: 'Tamanho',
      ordem: 2,
      permiteFotos: true,
      variacoes: [variante('v-p', 'P')],
    });
    const r = montarTiers(
      args({
        grupos: [cor, tam],
        imagensDeOpcao: new Map([
          [varianteFakePath('g-cor', 'v-azul'), 'img-a'],
          [varianteFakePath('g-tam', 'v-p'), 'img-p'],
        ]),
        filhos: [
          filho({
            produtoId: 'p-1',
            variacoesUid: [varianteFakePath('g-cor', 'v-azul'), varianteFakePath('g-tam', 'v-p')],
          }),
        ],
      }),
    );
    expect(r.tiers[0]!.opcoes.map((o) => o.image_id)).toEqual(['img-a']);
    expect(r.tiers[1]!.opcoes.map((o) => o.image_id)).toEqual([null]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (6) the ONE identity fold — the PAIR and the three NEAR-MISSES            */
/* -------------------------------------------------------------------------- */

describe('mesmoModelo — o ÚNICO fold desta pasta (par + três quase-casos)', () => {
  function armazenado(parcial: Partial<ModeloArmazenado>): ModeloArmazenado {
    return {
      produtoId: 'p-1',
      linkDocId: 'l-1',
      modelId: 0,
      modelSku: null,
      tierIndex: [],
      ...parcial,
    };
  }

  it('⚠️ PAR: casa por model_id mesmo com o sku renomeado e o tier_index movido', () => {
    expect(
      mesmoModelo(
        armazenado({ modelId: MODEL_ID, modelSku: 'AZ-P', tierIndex: [1, 0] }),
        modeloVivo({ model_id: MODEL_ID, model_sku: 'AZUL-P', tier_index: [0, 0] }),
      ),
    ).toBe(true);
  });

  it("⚠️ QUASE: NÃO casa 'az-p' com 'AZ-P' — igualdade exata, sem trim e sem caixa", () => {
    expect(
      mesmoModelo(
        armazenado({ modelId: 0, modelSku: 'az-p', tierIndex: [0, 1] }),
        modeloVivo({ model_id: 3000000001, model_sku: 'AZ-P', tier_index: [1, 0] }),
      ),
    ).toBe(false);
  });

  it('⚠️ QUASE: NÃO casa dois model_sku vazios — vazio não é identidade', () => {
    expect(
      mesmoModelo(
        armazenado({ modelId: 0, modelSku: null, tierIndex: [0] }),
        modeloVivo({ model_id: 3000000002, model_sku: '', tier_index: [1] }),
      ),
    ).toBe(false);
    expect(
      mesmoModelo(
        armazenado({ modelId: 0, modelSku: '', tierIndex: [0] }),
        modeloVivo({ model_id: 3000000003, model_sku: '', tier_index: [1] }),
      ),
    ).toBe(false);
  });

  it('⚠️ QUASE: NÃO casa tier_index [0,1] com [1,0] — a ordem é a coordenada', () => {
    expect(
      mesmoModelo(
        armazenado({ modelId: 0, modelSku: null, tierIndex: [0, 1] }),
        modeloVivo({ model_id: 3000000004, model_sku: null, tier_index: [1, 0] }),
      ),
    ).toBe(false);
    expect(
      mesmoModelo(
        armazenado({ modelId: 0, modelSku: null, tierIndex: [0, 1] }),
        modeloVivo({ model_id: 3000000005, model_sku: null, tier_index: [0, 1] }),
      ),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  (7) reconciliarModelos                                                     */
/* -------------------------------------------------------------------------- */

describe('reconciliarModelos — o model_list sai do get_model_list FRESCO', () => {
  const azul = variante('v-azul', 'Azul');
  const verde = variante('v-verde', 'Verde');
  const corComDuas = grupo({ grupoId: 'g-cor', variacoes: [azul, verde] });

  function montagemDeUmFilho(varianteId: string) {
    return montarTiers(
      args({
        grupos: [corComDuas],
        filhos: [
          filho({
            produtoId: `p-${varianteId}`,
            sku: 'AZ-P',
            linkDocId: 'l-1',
            variacoesUid: [varianteFakePath('g-cor', varianteId)],
          }),
        ],
      }),
    );
  }

  it('model_list re-lista TODO modelo vivo, inclusive os sem filho', () => {
    const nosso = montagemDeUmFilho('v-azul');
    const vivos = [
      modeloVivo({ model_id: MODEL_ID, tier_index: [0], model_sku: 'AZ-P' }),
      modeloVivo({ model_id: 3000000009, tier_index: [1], model_sku: 'VD-P' }),
    ];
    const plano = reconciliarModelos({
      montados: nosso.modelos,
      armazenados: [
        {
          produtoId: 'p-v-azul',
          linkDocId: 'l-1',
          modelId: MODEL_ID,
          modelSku: 'AZ-P',
          tierIndex: [0],
        },
      ],
      viva: { tier_variation: null, standardise_tier_variation: null, model: vivos },
      profundidadeNossa: 1,
    });
    expect(plano.modelList.map((l) => l.model_id)).toEqual([MODEL_ID, 3000000009]);
    expect(plano.modelosSemFilho.map((m) => m.model_id)).toEqual([3000000009]);
    expect(plano.novos).toEqual([]);
  });

  it('uma opção ocupada por um modelo sem filho permanece no conjunto enviado', () => {
    // Nosso único filho usa 'Verde'; o anúncio vivo tem [Azul, Verde] e um modelo
    // em Azul que não tem filho nenhum.
    const vivos = [modeloVivo({ model_id: MODEL_ID, tier_index: [0], model_sku: 'AZ-P' })];
    const r = montarTiers(
      args({
        grupos: [corComDuas],
        viva: arvore(['Azul', 'Verde'], vivos),
        filhos: [
          filho({
            produtoId: 'p-verde',
            variacoesUid: [varianteFakePath('g-cor', 'v-verde')],
          }),
        ],
      }),
    );
    expect(r.problemas).toEqual([]);
    expect(r.tiers[0]!.opcoes.map((o) => o.variation_option_name)).toEqual(['Azul', 'Verde']);
    expect(r.tiers[0]!.opcoes.map((o) => o.ocupadaPorModeloSemFilho)).toEqual([true, false]);
    // e o nosso filho ficou na posição 1, não na 0
    expect(r.modelos.map((m) => m.tier_index)).toEqual([[1]]);

    const plano = reconciliarModelos({
      montados: r.modelos,
      armazenados: [],
      viva: arvore(['Azul', 'Verde'], vivos),
      profundidadeNossa: 1,
    });
    expect(plano.modelList).toEqual([{ model_id: MODEL_ID, tier_index: [0] }]);
    expect(plano.novos.map((m) => m.tier_index)).toEqual([[1]]);
  });

  it('mudança de profundidade planeja init e novos carrega o model[] completo', () => {
    const nosso = montagemDeUmFilho('v-azul');
    const plano = reconciliarModelos({
      montados: nosso.modelos,
      armazenados: [],
      viva: {
        tier_variation: null,
        standardise_tier_variation: null,
        model: [modeloVivo({ model_id: MODEL_ID, tier_index: [0, 0] })],
      },
      profundidadeNossa: 1,
    });
    expect(plano.acao).toBe('init');
    expect(plano.mudouProfundidade).toBe(true);
    expect(plano.modelList).toEqual([]);
    expect(plano.novos).toEqual(nosso.modelos);
    expect(plano.modelosSemFilho).toEqual([]);
  });

  it('um link armazenado cujo modelo sumiu vira desaparecidos — nenhum caminho apaga link', () => {
    const nosso = montagemDeUmFilho('v-azul');
    const plano = reconciliarModelos({
      montados: nosso.modelos,
      armazenados: [
        {
          produtoId: 'p-fantasma',
          linkDocId: 'l-fantasma',
          modelId: 3000000099,
          modelSku: 'SUMIU',
          tierIndex: [7],
        },
      ],
      viva: {
        tier_variation: null,
        standardise_tier_variation: null,
        model: [modeloVivo({ model_id: MODEL_ID, tier_index: [0], model_sku: 'AZ-P' })],
      },
      profundidadeNossa: 1,
    });
    expect(plano.desaparecidos).toEqual([
      { produtoId: 'p-fantasma', linkDocId: 'l-fantasma', modelId: 3000000099 },
    ]);
    expect(Object.keys(plano).sort()).toEqual([
      'acao',
      'atualizarSku',
      'desaparecidos',
      'modelList',
      'modelosSemFilho',
      'mudouProfundidade',
      'novos',
    ]);
  });

  it('atualizarSku só sai por drift de model_sku ou gtin_code', () => {
    const nosso = montagemDeUmFilho('v-azul');
    const base = {
      montados: nosso.modelos,
      armazenados: [
        {
          produtoId: 'p-v-azul',
          linkDocId: 'l-1',
          modelId: MODEL_ID,
          modelSku: 'AZ-P',
          tierIndex: [0],
        },
      ],
      profundidadeNossa: 1,
    };
    const igual = reconciliarModelos({
      ...base,
      viva: {
        tier_variation: null,
        standardise_tier_variation: null,
        model: [modeloVivo({ model_id: MODEL_ID, tier_index: [0], model_sku: 'AZ-P' })],
      },
    });
    expect(igual.atualizarSku).toEqual([]);
    expect(igual.acao).toBe('nenhuma');

    const divergente = reconciliarModelos({
      ...base,
      viva: {
        tier_variation: null,
        standardise_tier_variation: null,
        model: [modeloVivo({ model_id: MODEL_ID, tier_index: [0], model_sku: 'OUTRO' })],
      },
    });
    expect(divergente.atualizarSku).toEqual([{ model_id: MODEL_ID, model_sku: 'AZ-P' }]);
    expect(divergente.acao).toBe('update');
  });

  it('⚠️ o degrau 1 vence a ORDEM das linhas: os dois get_model_list dão o MESMO plano', () => {
    // O operador re-ordenou as opções no Seller Centre para [Verde, Azul] depois
    // da última publicação: os dois modelos VIVOS mantiveram o id e trocaram de
    // coordenada, então o `tierIndex` ARMAZENADO de cada filho está velho
    // enquanto o `modelId` armazenado continua vivo. Os degraus avaliados por
    // CANDIDATO fariam o degrau 3 de uma linha ANTERIOR ganhar do degrau 1 de uma
    // linha POSTERIOR — e quem decidiria seria a ordem das linhas do
    // `get_model_list`, sobre a qual a Shopee não promete nada.
    const VERDE = MODEL_ID;
    const AZUL = MODEL_ID + 1;
    const vivoVerde = modeloVivo({ model_id: VERDE, tier_index: [0], model_sku: 'VD' });
    const vivoAzul = modeloVivo({ model_id: AZUL, tier_index: [1], model_sku: 'AZ' });

    const montagem = montarTiers(
      args({
        grupos: [corComDuas],
        viva: arvore(['Verde', 'Azul'], [vivoVerde, vivoAzul]),
        filhos: [
          filho({
            produtoId: 'p-azul',
            sku: 'AZ',
            linkDocId: 'l-azul',
            variacoesUid: [varianteFakePath('g-cor', 'v-azul')],
          }),
          filho({
            produtoId: 'p-verde',
            sku: 'VD',
            linkDocId: 'l-verde',
            variacoesUid: [varianteFakePath('g-cor', 'v-verde')],
          }),
        ],
      }),
    );
    expect(montagem.problemas).toEqual([]);

    const armazenados: readonly ModeloArmazenado[] = [
      // as coordenadas GUARDADAS são as de antes da re-ordenação
      { produtoId: 'p-azul', linkDocId: 'l-azul', modelId: AZUL, modelSku: 'AZ', tierIndex: [0] },
      {
        produtoId: 'p-verde',
        linkDocId: 'l-verde',
        modelId: VERDE,
        modelSku: 'VD',
        tierIndex: [1],
      },
    ];
    const plano = (ordem: readonly ShopeeModel[]) =>
      reconciliarModelos({
        montados: montagem.modelos,
        armazenados,
        viva: arvore(['Verde', 'Azul'], ordem),
        profundidadeNossa: 1,
      });

    const porCoordenada = plano([vivoVerde, vivoAzul]);
    const porOutraOrdem = plano([vivoAzul, vivoVerde]);

    // O plano é o MESMO nas duas leituras, a menos da ordem das linhas re-listadas.
    const chave = (p: ReturnType<typeof plano>) => ({
      acao: p.acao,
      modelList: [...p.modelList].sort((a, b) => a.model_id - b.model_id),
      atualizarSku: p.atualizarSku,
      novos: p.novos,
      modelosSemFilho: p.modelosSemFilho,
    });
    expect(chave(porCoordenada)).toEqual(chave(porOutraOrdem));

    // E o plano certo é "não mexe em nada": cada filho já está no seu modelo.
    expect(porCoordenada.acao).toBe('nenhuma');
    expect(porCoordenada.atualizarSku).toEqual([]);
    expect([...porCoordenada.modelList].sort((a, b) => a.model_id - b.model_id)).toEqual([
      { model_id: VERDE, tier_index: [0] },
      { model_id: AZUL, tier_index: [1] },
    ]);
  });

  it('⚠️ o model_list nunca põe dois modelos na MESMA coordenada', () => {
    // O mesmo estado do teste acima com UM filho só: se o degrau 3 do link velho
    // casasse com o modelo que ocupa hoje aquela coordenada, o `model_list` sairia
    // com dois model_id na mesma posição — e o `update_tier_variation` seria um
    // sobrescrevendo o outro.
    const VERDE = MODEL_ID;
    const AZUL = MODEL_ID + 1;
    const vivoVerde = modeloVivo({ model_id: VERDE, tier_index: [0], model_sku: 'VD' });
    const vivoAzul = modeloVivo({ model_id: AZUL, tier_index: [1], model_sku: 'AZ' });

    const montagem = montarTiers(
      args({
        grupos: [corComDuas],
        viva: arvore(['Verde', 'Azul'], [vivoVerde, vivoAzul]),
        filhos: [
          filho({
            produtoId: 'p-azul',
            sku: 'AZ',
            linkDocId: 'l-azul',
            variacoesUid: [varianteFakePath('g-cor', 'v-azul')],
          }),
        ],
      }),
    );
    expect(montagem.problemas).toEqual([]);

    for (const ordem of [
      [vivoVerde, vivoAzul],
      [vivoAzul, vivoVerde],
    ]) {
      const plano = reconciliarModelos({
        montados: montagem.modelos,
        armazenados: [
          {
            produtoId: 'p-azul',
            linkDocId: 'l-azul',
            modelId: AZUL,
            modelSku: 'AZ',
            tierIndex: [0],
          },
        ],
        viva: arvore(['Verde', 'Azul'], ordem),
        profundidadeNossa: 1,
      });
      const coordenadas = plano.modelList.map((l) => JSON.stringify(l.tier_index));
      expect(new Set(coordenadas).size).toBe(coordenadas.length);
      // e o filho continua casado com o SEU modelo, nunca com o vizinho
      expect(plano.atualizarSku).toEqual([]);
      expect(plano.modelosSemFilho.map((m) => m.model_id)).toEqual([VERDE]);
    }
  });

  it('um filho sem sku NÃO produz update_model — a string vazia DELETA', () => {
    const r = montarTiers(
      args({
        grupos: [corComDuas],
        filhos: [
          filho({ produtoId: 'p-azul', variacoesUid: [varianteFakePath('g-cor', 'v-azul')] }),
        ],
      }),
    );
    expect(r.modelos[0]!.model_sku).toBeUndefined();
    expect(requisicaoDeModelo(r.modelos[0]!)).not.toHaveProperty('model_sku');
    const plano = reconciliarModelos({
      montados: r.modelos,
      armazenados: [],
      viva: {
        tier_variation: null,
        standardise_tier_variation: null,
        model: [modeloVivo({ model_id: MODEL_ID, tier_index: [0], model_sku: 'ALGO' })],
      },
      profundidadeNossa: 1,
    });
    expect(plano.atualizarSku).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (7b) D-9 — the `filho-sem-preco` TEXT follows the price source            */
/* -------------------------------------------------------------------------- */

describe('montarTiers — D-9: o texto do `filho-sem-preco` nomeia quem tem o preço', () => {
  const azul = variante('v-azul', 'Azul');
  const verde = variante('v-verde', 'Verde');
  const cor = grupo({
    grupoId: 'g-cor',
    nome: 'Cor',
    variacoes: [azul, verde],
    linksVariacoesShopee: [entrada({ variation_id: 0 })],
  });

  /** Both children priceless; `fonte` spreads onto each (absent = the field is not set). */
  function recusasDePreco(fonte: Partial<FilhoParaPublicar>) {
    const filhos = [
      filho({
        produtoId: 'p-1',
        variacoesUid: [varianteFakePath('g-cor', 'v-azul')],
        preco: null,
        ...fonte,
      }),
      filho({
        produtoId: 'p-2',
        variacoesUid: [varianteFakePath('g-cor', 'v-verde')],
        preco: null,
        ...fonte,
      }),
    ];
    return montarTiers(args({ grupos: [cor], filhos })).problemas.filter(
      (p) => p.motivo === MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
    );
  }

  const textoDoPai = (id: string) =>
    `A variação ${id} não tem preço: o produto pai propaga o preço para as variações e não tem ` +
    'preço na tabela normal — defina o preço do pai ou desligue a propagação.';
  const textoDoFilho = (id: string) =>
    `A variação ${id} não tem preço e a Shopee exige um original_price por modelo.`;

  it('⚠️ PAR — o preço vem do PAI (`precoDoPai: true`) ⇒ cada recusa nomeia o PAI e o remédio; o motivo continua `filho-sem-preco`', () => {
    expect(recusasDePreco({ precoDoPai: true })).toEqual([
      {
        campo: 'model',
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
        mensagem: textoDoPai('p-1'),
      },
      {
        campo: 'model',
        motivo: MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
        mensagem: textoDoPai('p-2'),
      },
    ]);
  });

  it('⚠️ QUASE-IGUAL — os MESMOS filhos sem preço, com o preço PRÓPRIO (`precoDoPai: false`, ou ausente) ⇒ o texto de sempre, que nomeia a variação', () => {
    for (const fonte of [{ precoDoPai: false }, {}]) {
      expect(recusasDePreco(fonte).map((p) => p.mensagem)).toEqual([
        textoDoFilho('p-1'),
        textoDoFilho('p-2'),
      ]);
    }
  });

  it('a fonte não muda o que é recusado: filhos COM preço vindo do pai não recusam nada', () => {
    const filhos = [
      filho({ produtoId: 'p-1', variacoesUid: [varianteFakePath('g-cor', 'v-azul')] }),
      filho({ produtoId: 'p-2', variacoesUid: [varianteFakePath('g-cor', 'v-verde')] }),
    ].map((f) => ({ ...f, precoDoPai: true }));
    const montado = montarTiers(args({ grupos: [cor], filhos }));
    expect(motivos(montado.problemas)).not.toContain('filho-sem-preco');
  });
});

/* -------------------------------------------------------------------------- */
/*  (8) folder discipline — no local copy of a wire bound                      */
/* -------------------------------------------------------------------------- */

describe('disciplina do módulo', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./tiersPublicacao.ts', import.meta.url)),
    'utf8',
  );

  it('não declara nenhuma constante com o prefixo reservado do pacote', () => {
    expect(fonte.length).toBeGreaterThan(1_000);
    expect(/export const SHOPEE_/.test(fonte)).toBe(false);
  });

  it('#1911 (#1369): a chave do vínculo é a COMPARTILHADA — o módulo não a soletra uma segunda vez', () => {
    expect(fonte).toContain('resolverEntradaShopeeDoGrupo(');
    // no local parse of the entry, and no local compare of either half of the key
    expect(fonte.includes(['linkVariacoesShopee', 'Schema'].join(''))).toBe(false);
    expect(/\.integracaoShopeeId\s*[!=]==/.test(fonte)).toBe(false);
    expect(/\.category_id\s*[!=]==/.test(fonte)).toBe(false);
    expect(/split\(['"]\/['"]\)/.test(fonte)).toBe(false);
  });

  it('#1911 batch-A (#1369): a dobra de NOME é a do leitor — nenhuma cópia local de trim/caixa', () => {
    // The pairs and near-misses in (2d) pin the behaviour; this only catches a
    // local RE-spelling of the fold — the shape that let the reader trim while
    // this module compared verbatim.
    expect(fonte).toContain('nomeDeTierShopee(');
    expect(/\.trim\(\)/.test(fonte)).toBe(false);
    expect(/\.toLowerCase\(\)/.test(fonte)).toBe(false);
  });

  it('não nomeia nenhum dos helpers GENÉRICOS de equivalência (as duas dobras compartilhadas que usa estão no inventário)', () => {
    for (const nome of [
      ['normalize', 'Loose'].join(''),
      ['deep', 'Equal'].join(''),
      ['strip', 'Nulls', 'Deep'].join(''),
      ['parse', 'Decimal', 'PtBr'].join(''),
    ]) {
      expect(fonte.includes(nome)).toBe(false);
    }
  });
});

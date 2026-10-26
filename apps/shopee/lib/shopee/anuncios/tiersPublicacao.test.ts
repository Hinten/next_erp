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
import { varianteFakePath, type Foto } from '@delfrance/schemas';

import { MOTIVO_PUBLICACAO_BLOQUEADA } from './errosPublicacao';

import {
  fotoDaOpcaoDeTier,
  mesmoModelo,
  montarTiers,
  ordenarTiers,
  reconciliarModelos,
  requisicaoDeModelo,
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
        { nome: 'Cor', variationId: 0, opcoes: [], indice: 0 },
        { nome: 'Tamanho', variationId: 0, opcoes: [], indice: 1 },
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

const TEXTO_NAO_CASA = (grupoNome: string): string =>
  `O tier "${grupoNome}" não casa pelo nome com nenhum tier do anúncio (grupo renomeado, ou anúncio exportado pelo app antigo) — republicar reescreveria as opções. Importe o anúncio ou ajuste o nome do grupo.`;

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

/** The fixture's `variation_group_list: [1, 2]`: an element the strict schema REFUSES. */
function entradaQuebrada(parcial: Parameters<typeof entrada>[0] = {}): unknown {
  return { ...(entrada(parcial) as object), variation_group_list: [1, 2] };
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

  it('⚠️ PAR: casado pelo nome BYTE-IGUAL ⇒ as opções e os índices vivos ficam — implícito OU entrada importada', () => {
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

  it("⚠️ QUASE: 'Cor ' não é 'Cor' (sem trim) ⇒ o tier implícito que não casa é RECUSADO, nada é montado", () => {
    const r = montarTiers(
      args({ grupos: [grupoCor('Cor ', null)], filhos: filhosCor, viva: VIVA_COR }),
    );
    expect(r.problemas).toEqual([recusaNaoCasa('Cor ')]);
    expect(r.tiers).toEqual([]);
    expect(r.modelos).toEqual([]);
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
    expect(implicito.problemas).toEqual([recusaNaoCasa('Cor')]);

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
    expect(r.problemas).toEqual([recusaNaoCasa('Cor')]);
    expect(r.tiers).toEqual([]);
    expect(r.modelos).toEqual([]);
  });

  it('o PAREAMENTO de um tier padrão lê a chave compartilhada com a conta e a folha DESTA publicação', () => {
    // The live standard tier holds [Verde(6), Azul(5)] with a model on each; only
    // `v-azul` is published. Paired, the live list is the base and the child sits
    // at index 1; unpaired, the tier would be rebuilt as [Azul] and re-code it.
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

  it('modelos vivos sem NENHUM tier legível, na mesma profundidade: não há com o que casar ⇒ RECUSADO', () => {
    // `get_model_list` with models always carries its tiers; when none can be
    // read (both trees absent, or every tier nameless) the options cannot be
    // re-sent at the live positions, so the publish refuses like a hole does.
    const viva: ArvoreVivaDoItem = {
      tier_variation: null,
      standardise_tier_variation: null,
      model: [modeloVivo({ model_id: AZUL, tier_index: [0], model_sku: 'AZ' })],
    };
    const r = montarTiers(
      args({ grupos: [grupoCor('Cor', [ENTRADA_IMPORTADA])], filhos: [filhosCor[0]!], viva }),
    );
    expect(r.problemas).toEqual([recusaNaoCasa('Cor')]);
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

  it('não nomeia nenhum helper de equivalência compartilhado', () => {
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

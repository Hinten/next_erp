import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SHOPEE_MODEL_MAX_PER_ITEM,
  SHOPEE_TIER_MAX_OPTIONS,
  shopeeModelSchema,
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

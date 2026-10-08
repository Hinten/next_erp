import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { ShopeeConfigError } from '../src/errors';
import * as publico from '../src/index';
import * as modulo from '../src/kits';
import {
  type GenerateKitImageParams,
  SHOPEE_ADD_KIT_ITEM_PATH,
  SHOPEE_GENERATE_KIT_IMAGE_PATH,
  SHOPEE_KIT_IMAGE_COMPONENTES_MAX,
  SHOPEE_KIT_IMAGE_COMPONENTES_MIN,
  SHOPEE_KIT_IMAGE_MAX,
  SHOPEE_KIT_ITEM_LIMIT_ERROR_ALIASES,
  SHOPEE_KIT_MAX_MODELS,
  SHOPEE_UPDATE_KIT_ITEM_PATH,
  type ShopeeAddKitItemRequest,
  type ShopeeKitComponentRequest,
  type ShopeeKitItemSetting,
  type ShopeeKitModelRequest,
  type ShopeeUpdateKitItemRequest,
  type ShopeeUpdateKitModelRequest,
  assertAddKitItemRequest,
  assertGenerateKitImageParams,
  assertUpdateKitItemRequest,
  linhasDeReenvioDoKit,
} from '../src/kits';
import {
  SHOPEE_ITEM_IMAGE_MAX,
  SHOPEE_MODEL_SKU_MAX_LENGTH,
  shopeeKitModelSchema,
} from '../src/types';

/*
 * Ids de FIXTURE por papel (D1) — nunca de uma loja real:
 *   kit 2500139870 / modelo 2000458820 (+ o anexado 2000458822);
 *   componente A (com variações) 2500139871 / modelo 2000458821;
 *   componente B (SEM variações) 2500139872 / modelo OCULTO 2000458829.
 * A imagem e o canal logístico são amostras da própria doc da Shopee.
 */
const KIT = 2500139870;
const MODELO_KIT = 2000458820;
const MODELO_KIT_2 = 2000458822;
const ITEM_A = 2500139871;
const MODELO_A = 2000458821;
const ITEM_B = 2500139872;
const MODELO_OCULTO_B = 2000458829;
const IMAGEM = 'br-11134207-7r98o-lzri4neb5vcv18';
const CANAL_DOC = 90003;

const FONTE = readFileSync(new URL('../src/kits.ts', import.meta.url), 'utf8');

/** Roda `fn` e devolve o `ShopeeConfigError` que ela lançou — falha se não lançou ou lançou outra coisa. */
function recusa(fn: () => void): ShopeeConfigError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ShopeeConfigError) return err;
    throw err;
  }
  throw new Error('esperava um ShopeeConfigError, e nada foi lançado');
}

/** `true` quando o guarda aceita; `false` quando recusa com `ShopeeConfigError`. */
function aceita(fn: () => void): boolean {
  try {
    fn();
    return true;
  } catch (err) {
    if (err instanceof ShopeeConfigError) return false;
    throw err;
  }
}

/** A linha de A (com modelo), opcionalmente a principal. */
function linhaA(quantity: number, main?: boolean): ShopeeKitComponentRequest {
  return {
    component_item_id: ITEM_A,
    component_model_id: MODELO_A,
    quantity,
    ...(main === undefined ? {} : { main_component: main }),
  };
}

/** A linha de B — item SEM variações, então SEM `component_model_id` na criação. */
function linhaB(quantity: number, main?: boolean): ShopeeKitComponentRequest {
  return {
    component_item_id: ITEM_B,
    quantity,
    ...(main === undefined ? {} : { main_component: main }),
  };
}

/** Dois modelos (P e M), UM principal no kit inteiro — no modelo 0. */
const MODELOS_BASE: readonly ShopeeKitModelRequest[] = [
  { tier_index: [0], original_price: 49.9, component_list: [linhaA(1, true), linhaB(1)] },
  { tier_index: [1], original_price: 59.9, component_list: [linhaA(2), linhaB(1)] },
];

function setting(extra: Partial<ShopeeKitItemSetting> = {}): ShopeeKitItemSetting {
  return {
    item_name: 'Kit de teste',
    images: { image_id_list: [IMAGEM] },
    description_type: 'normal',
    description: 'Descrição do kit de teste',
    logistic_info: [{ logistic_id: CANAL_DOC, enabled: true }],
    weight: 1.5,
    item_sku: 'KIT-1',
    tier_variation_list: [{ name: 'Tamanho', option_list: [{ option: 'P' }, { option: 'M' }] }],
    model_list: MODELOS_BASE,
    ...extra,
  };
}

function criacao(extra: Partial<ShopeeKitItemSetting> = {}): ShopeeAddKitItemRequest {
  return { item_setting: setting(extra) };
}

/** Um tier de `n` opções (`O1`…`On`). */
function tierDe(n: number): ShopeeKitItemSetting['tier_variation_list'] {
  return [
    {
      name: 'Tamanho',
      option_list: Array.from({ length: n }, (_, i) => ({ option: `O${String(i + 1)}` })),
    },
  ];
}

/** `n` modelos com UM principal no primeiro — o kit válido de `n` opções. */
function modelosDe(n: number): ShopeeKitModelRequest[] {
  return Array.from({ length: n }, (_, i) => ({
    tier_index: [i] as const,
    original_price: 10 + i,
    component_list: [linhaA(1, i === 0), linhaB(1)],
  }));
}

/** O corpo PARCIAL de P2-c: só o modelo mudado, sem tier, as linhas vivas reenviadas. */
function atualizacaoParcial(
  modelo: Partial<ShopeeUpdateKitModelRequest> = {},
): ShopeeUpdateKitItemRequest {
  return {
    item_id: KIT,
    item_setting: {
      model_list: [
        {
          model_id: MODELO_KIT,
          tier_index: [0],
          original_price: 39.9,
          component_list: [
            {
              component_item_id: ITEM_A,
              component_model_id: MODELO_A,
              quantity: 1,
              main_component: true,
            },
            { component_item_id: ITEM_B, component_model_id: MODELO_OCULTO_B, quantity: 1 },
          ],
          ...modelo,
        },
      ],
    },
  };
}

/** Um ANEXO: o modelo vivo reenviado + um `model_id: 0` com o tier INTEIRO. */
function atualizacaoComAnexo(
  anexado: Partial<ShopeeUpdateKitModelRequest> = {},
  comTier = true,
): ShopeeUpdateKitItemRequest {
  return {
    item_id: KIT,
    item_setting: {
      model_list: [
        {
          model_id: MODELO_KIT,
          tier_index: [0],
          component_list: [
            {
              component_item_id: ITEM_A,
              component_model_id: MODELO_A,
              quantity: 1,
              main_component: true,
            },
            { component_item_id: ITEM_B, component_model_id: MODELO_OCULTO_B, quantity: 1 },
          ],
        },
        {
          model_id: 0,
          tier_index: [1],
          original_price: 59.9,
          component_list: [linhaA(2), linhaB(1)],
          ...anexado,
        },
      ],
      ...(comTier
        ? {
            tier_variation_list: [
              { name: 'Tamanho', option_list: [{ option: 'P' }, { option: 'M' }] },
            ] as const,
          }
        : {}),
    },
  };
}

/* -------------------------------------------------------------------------- */

describe('kits — os caminhos e as constantes do fio (passo 19)', () => {
  it('os três caminhos são os do cabeçalho das páginas, byte a byte', () => {
    expect(SHOPEE_ADD_KIT_ITEM_PATH).toBe('/api/v2/product/add_kit_item');
    expect(SHOPEE_UPDATE_KIT_ITEM_PATH).toBe('/api/v2/product/update_kit_item');
    expect(SHOPEE_GENERATE_KIT_IMAGE_PATH).toBe('/api/v2/product/generate_kit_image');
  });

  it('M39 — o teto de imagens do KIT é 10 e NÃO é o do item (9): as duas constantes nunca se fundem', () => {
    expect(SHOPEE_KIT_IMAGE_MAX).toBe(10);
    expect(SHOPEE_ITEM_IMAGE_MAX).toBe(9);
    expect(SHOPEE_KIT_IMAGE_MAX).not.toBe(SHOPEE_ITEM_IMAGE_MAX);
    expect(SHOPEE_KIT_MAX_MODELS).toBe(9);
    expect(SHOPEE_KIT_IMAGE_COMPONENTES_MIN).toBe(2);
    expect(SHOPEE_KIT_IMAGE_COMPONENTES_MAX).toBe(9);
  });

  it('M31 — o apelido do get_kit_item_limit é EXATAMENTE `["-"]`: nem `" "`, nem uma dobra', () => {
    expect([...SHOPEE_KIT_ITEM_LIMIT_ERROR_ALIASES]).toStrictEqual(['-']);
    expect(SHOPEE_KIT_ITEM_LIMIT_ERROR_ALIASES).not.toContain(' ');
    expect(SHOPEE_KIT_ITEM_LIMIT_ERROR_ALIASES).not.toContain('');
  });

  it('saem pela porta pública do pacote (`index.ts` re-exporta o módulo por wildcard)', () => {
    expect(publico.SHOPEE_ADD_KIT_ITEM_PATH).toBe(SHOPEE_ADD_KIT_ITEM_PATH);
    expect(publico.SHOPEE_UPDATE_KIT_ITEM_PATH).toBe(SHOPEE_UPDATE_KIT_ITEM_PATH);
    expect(publico.SHOPEE_GENERATE_KIT_IMAGE_PATH).toBe(SHOPEE_GENERATE_KIT_IMAGE_PATH);
    expect(publico.SHOPEE_KIT_MAX_MODELS).toBe(SHOPEE_KIT_MAX_MODELS);
    expect(publico.SHOPEE_KIT_IMAGE_MAX).toBe(SHOPEE_KIT_IMAGE_MAX);
    expect(publico.SHOPEE_KIT_ITEM_LIMIT_ERROR_ALIASES).toBe(SHOPEE_KIT_ITEM_LIMIT_ERROR_ALIASES);
    expect(publico.assertAddKitItemRequest).toBe(assertAddKitItemRequest);
    expect(publico.assertUpdateKitItemRequest).toBe(assertUpdateKitItemRequest);
    expect(publico.assertGenerateKitImageParams).toBe(assertGenerateKitImageParams);
    expect(publico.linhasDeReenvioDoKit).toBe(linhasDeReenvioDoKit);
  });

  it('FONTE: de `./api` só TIPOS (aresta apagada, sem ciclo em runtime); nenhuma constante de contagem de componentes', () => {
    // Cada declaração `import … from '…';`, inteira (o prettier pode quebrá-la em linhas).
    const deApi = (FONTE.match(/^import [^;]*;$/gm) ?? []).filter((d) =>
      d.endsWith("from './api';"),
    );
    expect(deApi).toHaveLength(1);
    expect(deApi[0]).toMatch(/^import type \{/);
    // ⚠️ A faixa de componentes POR MODELO é da app (servida pelo get_kit_item_limit)
    // — três frases da doc discordam, então o pacote não fixa 2–10. As constantes
    // `SHOPEE_KIT_*` são exatamente estas cinco; uma sexta é uma decisão, não um detalhe.
    expect(
      Object.keys(modulo)
        .filter((k) => k.startsWith('SHOPEE_KIT_'))
        .sort(),
    ).toStrictEqual([
      'SHOPEE_KIT_IMAGE_COMPONENTES_MAX',
      'SHOPEE_KIT_IMAGE_COMPONENTES_MIN',
      'SHOPEE_KIT_IMAGE_MAX',
      'SHOPEE_KIT_ITEM_LIMIT_ERROR_ALIASES',
      'SHOPEE_KIT_MAX_MODELS',
    ]);
  });

  it('o TIPO descreve o fio: `seller_stock` e `category_id` não existem no item_setting de um kit', () => {
    const base = setting();
    // @ts-expect-error — kit não tem estoque no corpo: a Shopee deriva dos componentes.
    const comEstoque: ShopeeKitItemSetting = { ...base, seller_stock: [{ stock: 1 }] };
    // @ts-expect-error — a categoria SINCRONIZA do componente principal.
    const comCategoria: ShopeeKitItemSetting = { ...base, category_id: 107290 };
    expect(comEstoque.item_name).toBe(comCategoria.item_name);
  });
});

/* -------------------------------------------------------------------------- */

describe('assertAddKitItemRequest — antes do token, nunca ecoa um valor', () => {
  it('aceita a família de dois modelos com UM principal no kit inteiro, e o kit de um modelo `Kit`/`Padrão`', () => {
    expect(aceita(() => assertAddKitItemRequest(criacao()))).toBe(true);
    const umModelo = criacao({
      tier_variation_list: [{ name: 'Kit', option_list: [{ option: 'Padrão' }] }],
      model_list: [{ tier_index: [0], original_price: 49.9, component_list: [linhaB(2, true)] }],
    });
    expect(aceita(() => assertAddKitItemRequest(umModelo))).toBe(true);
    expect(
      aceita(() =>
        assertAddKitItemRequest({ ...criacao(), sync_setting: { auto_sync_dts: true } }),
      ),
    ).toBe(true);
  });

  it('M33 — `component_model_id: 0` é RECUSADO (omita a chave); omitido e positivo passam', () => {
    const comZero = criacao({
      model_list: [
        {
          tier_index: [0],
          original_price: 49.9,
          component_list: [
            linhaA(1, true),
            { component_item_id: ITEM_B, component_model_id: 0, quantity: 1 },
          ],
        },
        MODELOS_BASE[1]!,
      ],
    });
    const erro = recusa(() => assertAddKitItemRequest(comZero));
    expect(erro.message).toContain(
      'item_setting.model_list[0].component_list[1].component_model_id',
    );
    expect(erro.message).toContain('OMITA');
    // Quase-igual: o MESMO corpo com a chave omitida (B sem variações) passa — é a base.
    expect(aceita(() => assertAddKitItemRequest(criacao()))).toBe(true);
    // E o id oculto positivo (o reenvio verbatim) também.
    const comOculto = criacao({
      model_list: [
        {
          tier_index: [0],
          original_price: 49.9,
          component_list: [
            linhaA(1, true),
            { component_item_id: ITEM_B, component_model_id: MODELO_OCULTO_B, quantity: 1 },
          ],
        },
        MODELOS_BASE[1]!,
      ],
    });
    expect(aceita(() => assertAddKitItemRequest(comOculto))).toBe(true);
    // Negativo e fracionário também caem.
    for (const ruim of [-1, 1.5]) {
      const corpo = criacao({
        model_list: [
          {
            tier_index: [0],
            original_price: 49.9,
            component_list: [
              linhaA(1, true),
              { component_item_id: ITEM_B, component_model_id: ruim, quantity: 1 },
            ],
          },
          MODELOS_BASE[1]!,
        ],
      });
      expect(
        aceita(() => assertAddKitItemRequest(corpo)),
        String(ruim),
      ).toBe(false);
    }
  });

  it('M34 — UM principal por KIT, nunca por modelo: um no kit todo passa; dois em dois modelos, zero, ou dois num modelo caem', () => {
    // A base: modelo 0 tem o principal, modelo 1 não tem — UM no kit (P2-a).
    expect(aceita(() => assertAddKitItemRequest(criacao()))).toBe(true);

    const doisEmDois = criacao({
      model_list: [
        MODELOS_BASE[0]!,
        { tier_index: [1], original_price: 59.9, component_list: [linhaA(2, true), linhaB(1)] },
      ],
    });
    const erro = recusa(() => assertAddKitItemRequest(doisEmDois));
    expect(erro.message).toContain('kit inteiro');
    expect(erro.message).toContain('mupltiple main sku');

    const nenhum = criacao({
      model_list: [
        { tier_index: [0], original_price: 49.9, component_list: [linhaA(1), linhaB(1)] },
        MODELOS_BASE[1]!,
      ],
    });
    expect(aceita(() => assertAddKitItemRequest(nenhum))).toBe(false);

    const doisNoMesmo = criacao({
      model_list: [
        {
          tier_index: [0],
          original_price: 49.9,
          component_list: [linhaA(1, true), linhaB(1, true)],
        },
        MODELOS_BASE[1]!,
      ],
    });
    expect(aceita(() => assertAddKitItemRequest(doisNoMesmo))).toBe(false);

    // `main_component: false` explícito não conta — só `true`.
    const comFalso = criacao({
      model_list: [
        MODELOS_BASE[0]!,
        {
          tier_index: [1],
          original_price: 59.9,
          component_list: [linhaA(2, false), linhaB(1, false)],
        },
      ],
    });
    expect(aceita(() => assertAddKitItemRequest(comFalso))).toBe(true);
  });

  it('M35 — anúncio 1262: um modelo com UMA linha precisa de quantity >= 2; duas linhas de 1 passam', () => {
    const umPorUm = criacao({
      tier_variation_list: [{ name: 'Kit', option_list: [{ option: 'Padrão' }] }],
      model_list: [{ tier_index: [0], original_price: 49.9, component_list: [linhaB(1, true)] }],
    });
    const erro = recusa(() => assertAddKitItemRequest(umPorUm));
    expect(erro.message).toContain('quantity >= 2');
    expect(erro.message).toContain('1262');

    const umPorDois = criacao({
      tier_variation_list: [{ name: 'Kit', option_list: [{ option: 'Padrão' }] }],
      model_list: [{ tier_index: [0], original_price: 49.9, component_list: [linhaB(2, true)] }],
    });
    expect(aceita(() => assertAddKitItemRequest(umPorDois))).toBe(true);

    // Quase-igual: a regra é sobre o NÚMERO de linhas, não sobre a soma — duas linhas de 1 passam.
    const duasDeUm = criacao({
      tier_variation_list: [{ name: 'Kit', option_list: [{ option: 'Padrão' }] }],
      model_list: [
        { tier_index: [0], original_price: 49.9, component_list: [linhaA(1, true), linhaB(1)] },
      ],
    });
    expect(aceita(() => assertAddKitItemRequest(duasDeUm))).toBe(true);
  });

  it('M39 — 1…10 imagens: 10 passam (o kit NÃO é capado em 9), 11 e 0 caem, um id em branco cai', () => {
    const ids = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `${IMAGEM}-${String(i)}`);
    expect(
      aceita(() => assertAddKitItemRequest(criacao({ images: { image_id_list: ids(10) } }))),
    ).toBe(true);
    expect(
      aceita(() => assertAddKitItemRequest(criacao({ images: { image_id_list: ids(9) } }))),
    ).toBe(true);
    expect(
      aceita(() => assertAddKitItemRequest(criacao({ images: { image_id_list: ids(11) } }))),
    ).toBe(false);
    expect(aceita(() => assertAddKitItemRequest(criacao({ images: { image_id_list: [] } })))).toBe(
      false,
    );
    expect(
      aceita(() => assertAddKitItemRequest(criacao({ images: { image_id_list: [IMAGEM, ' '] } }))),
    ).toBe(false);
  });

  it('o tier: UM só, 1…9 opções não vazias, imagens de opção tudo-ou-nada; e a BIJEÇÃO opção ↔ modelo', () => {
    // Uma opção SEM modelo (3 opções, 2 modelos) cai.
    const opcaoSobrando = recusa(() =>
      assertAddKitItemRequest(criacao({ tier_variation_list: tierDe(3) })),
    );
    expect(opcaoSobrando.message).toContain('cada opção precisa de exatamente um modelo');
    // Dois modelos na MESMA opção caem.
    const repetida = criacao({
      model_list: [MODELOS_BASE[0]!, { ...MODELOS_BASE[1]!, tier_index: [0] }],
    });
    expect(aceita(() => assertAddKitItemRequest(repetida))).toBe(false);
    // Um índice FORA do tier cai.
    const fora = criacao({
      model_list: [MODELOS_BASE[0]!, { ...MODELOS_BASE[1]!, tier_index: [2] }],
    });
    expect(aceita(() => assertAddKitItemRequest(fora))).toBe(false);
    // Dois níveis de tier_index caem.
    const doisNiveis = criacao({
      model_list: [
        MODELOS_BASE[0]!,
        { ...MODELOS_BASE[1]!, tier_index: [1, 0] as unknown as readonly [number] },
      ],
    });
    expect(aceita(() => assertAddKitItemRequest(doisNiveis))).toBe(false);
    // Dois tiers caem.
    const doisTiers = criacao({
      tier_variation_list: [
        ...tierDe(2),
        ...tierDe(2),
      ] as unknown as ShopeeKitItemSetting['tier_variation_list'],
    });
    expect(aceita(() => assertAddKitItemRequest(doisTiers))).toBe(false);
    // Uma opção em branco cai.
    const opcaoVazia = criacao({
      tier_variation_list: [{ name: 'Tamanho', option_list: [{ option: 'P' }, { option: '  ' }] }],
    });
    expect(aceita(() => assertAddKitItemRequest(opcaoVazia))).toBe(false);
    // Imagens: uma de duas cai; as duas ou nenhuma passam.
    const umaImagem = criacao({
      tier_variation_list: [
        {
          name: 'Tamanho',
          option_list: [{ option: 'P', image: { image_id: IMAGEM } }, { option: 'M' }],
        },
      ],
    });
    expect(recusa(() => assertAddKitItemRequest(umaImagem)).message).toContain('tudo-ou-nada');
    const duasImagens = criacao({
      tier_variation_list: [
        {
          name: 'Tamanho',
          option_list: [
            { option: 'P', image: { image_id: IMAGEM } },
            { option: 'M', image: { image_id: IMAGEM } },
          ],
        },
      ],
    });
    expect(aceita(() => assertAddKitItemRequest(duasImagens))).toBe(true);
  });

  it('1…9 modelos: 9 passam, 10 caem; nenhum modelo cai', () => {
    expect(
      aceita(() =>
        assertAddKitItemRequest(
          criacao({ tier_variation_list: tierDe(9), model_list: modelosDe(9) }),
        ),
      ),
    ).toBe(true);
    expect(
      aceita(() =>
        assertAddKitItemRequest(
          criacao({ tier_variation_list: tierDe(10), model_list: modelosDe(10) }),
        ),
      ),
    ).toBe(false);
    expect(
      aceita(() =>
        assertAddKitItemRequest(
          criacao({ tier_variation_list: tierDe(9), model_list: modelosDe(10) }),
        ),
      ),
    ).toBe(false);
    expect(aceita(() => assertAddKitItemRequest(criacao({ model_list: [] })))).toBe(false);
  });

  it('por modelo: preço em centavos, model_sku <= 100, linhas presentes, positivas e sem par repetido', () => {
    const comModelo0 = (m: Partial<ShopeeKitModelRequest>): ShopeeAddKitItemRequest =>
      criacao({ model_list: [{ ...MODELOS_BASE[0]!, ...m }, MODELOS_BASE[1]!] });

    for (const preco of [49.999, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        aceita(() => assertAddKitItemRequest(comModelo0({ original_price: preco }))),
        String(preco),
      ).toBe(false);
    }
    expect(aceita(() => assertAddKitItemRequest(comModelo0({ original_price: 49.99 })))).toBe(true);

    const sku = (n: number): string => 'S'.repeat(n);
    expect(
      aceita(() =>
        assertAddKitItemRequest(comModelo0({ model_sku: sku(SHOPEE_MODEL_SKU_MAX_LENGTH) })),
      ),
    ).toBe(true);
    expect(
      aceita(() =>
        assertAddKitItemRequest(comModelo0({ model_sku: sku(SHOPEE_MODEL_SKU_MAX_LENGTH + 1) })),
      ),
    ).toBe(false);

    expect(aceita(() => assertAddKitItemRequest(comModelo0({ component_list: [] })))).toBe(false);
    for (const q of [0, -1, 1.5]) {
      expect(
        aceita(() =>
          assertAddKitItemRequest(comModelo0({ component_list: [linhaA(1, true), linhaB(q)] })),
        ),
        String(q),
      ).toBe(false);
    }
    expect(
      aceita(() =>
        assertAddKitItemRequest(
          comModelo0({ component_list: [linhaA(1, true), { component_item_id: 0, quantity: 1 }] }),
        ),
      ),
    ).toBe(false);

    // O MESMO par (item, modelo) duas vezes num modelo cai…
    expect(
      aceita(() =>
        assertAddKitItemRequest(comModelo0({ component_list: [linhaA(1, true), linhaA(2)] })),
      ),
    ).toBe(false);
    expect(
      aceita(() =>
        assertAddKitItemRequest(comModelo0({ component_list: [linhaB(1, true), linhaB(2)] })),
      ),
    ).toBe(false);
    // …e o quase-igual: o MESMO item com e sem modelo são DOIS endereços.
    expect(
      aceita(() =>
        assertAddKitItemRequest(
          comModelo0({
            component_list: [linhaA(1, true), { component_item_id: ITEM_A, quantity: 1 }],
          }),
        ),
      ),
    ).toBe(true);
  });

  it('o item: nome, descrição, peso, canais, dimensões, description_type e sync_setting', () => {
    const ruins: readonly (readonly [string, Partial<ShopeeKitItemSetting>])[] = [
      ['nome em branco', { item_name: '   ' }],
      ['descrição vazia', { description: '' }],
      ['peso 0', { weight: 0 }],
      ['peso NaN', { weight: Number.NaN }],
      ['sem canal', { logistic_info: [] }],
      ['canal 0', { logistic_info: [{ logistic_id: 0, enabled: true }] }],
      ['dimensão 0', { dimension: { package_height: 0, package_length: 10, package_width: 10 } }],
      ['extended', { description_type: 'extended' as unknown as 'normal' }],
      ['unlisted texto', { unlisted: 'false' as unknown as boolean }],
    ];
    for (const [rotulo, mudanca] of ruins) {
      expect(
        aceita(() => assertAddKitItemRequest(criacao(mudanca))),
        rotulo,
      ).toBe(false);
    }
    expect(
      aceita(() =>
        assertAddKitItemRequest(
          criacao({
            dimension: { package_height: 10, package_length: 20, package_width: 30 },
            unlisted: false,
          }),
        ),
      ),
    ).toBe(true);
    const syncRuim = {
      ...criacao(),
      sync_setting: { auto_sync_dts: 'true' },
    } as unknown as ShopeeAddKitItemRequest;
    expect(aceita(() => assertAddKitItemRequest(syncRuim))).toBe(false);
  });

  it('nenhuma recusa ecoa o VALOR — só o campo, a posição, uma contagem ou um tipo', () => {
    const sku = 'SKU-SECRETO-'.repeat(10);
    const casos: readonly (readonly [string, ShopeeAddKitItemRequest])[] = [
      [
        '49.999',
        criacao({
          model_list: [{ ...MODELOS_BASE[0]!, original_price: 49.999 }, MODELOS_BASE[1]!],
        }),
      ],
      [
        'SKU-SECRETO',
        criacao({ model_list: [{ ...MODELOS_BASE[0]!, model_sku: sku }, MODELOS_BASE[1]!] }),
      ],
      ['-7.25', criacao({ weight: -7.25 })],
      [
        '987.5',
        criacao({
          model_list: [
            {
              ...MODELOS_BASE[0]!,
              component_list: [linhaA(1, true), { component_item_id: 987.5, quantity: 1 }],
            },
            MODELOS_BASE[1]!,
          ],
        }),
      ],
    ];
    for (const [valor, corpo] of casos) {
      const erro = recusa(() => assertAddKitItemRequest(corpo));
      expect(erro.message, valor).not.toContain(valor);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('assertUpdateKitItemRequest — PARCIAL (P2-c), anexo com o tier inteiro', () => {
  it('M38 — o corpo PARCIAL de P2-c passa: só o modelo mudado, sem tier_variation_list', () => {
    expect(aceita(() => assertUpdateKitItemRequest(atualizacaoParcial()))).toBe(true);
    // Mesmo sem original_price — um modelo existente carrega só o que muda.
    expect(
      aceita(() =>
        assertUpdateKitItemRequest(
          atualizacaoParcial({ original_price: undefined, model_sku: 'KIT-1-P' }),
        ),
      ),
    ).toBe(true);
  });

  it('M38 — um ANEXO (model_id 0) sem tier_variation_list, sem component_list ou sem original_price cai; com os três passa', () => {
    expect(aceita(() => assertUpdateKitItemRequest(atualizacaoComAnexo()))).toBe(true);

    const semTier = recusa(() => assertUpdateKitItemRequest(atualizacaoComAnexo({}, false)));
    expect(semTier.message).toContain('tier_variation_list');
    const semLinhas = recusa(() =>
      assertUpdateKitItemRequest(atualizacaoComAnexo({ component_list: undefined })),
    );
    expect(semLinhas.message).toContain('component_list');
    const semPreco = recusa(() =>
      assertUpdateKitItemRequest(atualizacaoComAnexo({ original_price: undefined })),
    );
    expect(semPreco.message).toContain('original_price');
    // O anexo passa pelas MESMAS regras de modelo da criação.
    expect(
      aceita(() =>
        assertUpdateKitItemRequest(atualizacaoComAnexo({ component_list: [linhaB(1)] })),
      ),
    ).toBe(false);
  });

  it('principal: no máximo UM na lista enviada e NENHUM num modelo anexado (o principal é congelado)', () => {
    const anexoPrincipal = recusa(() =>
      assertUpdateKitItemRequest(
        atualizacaoComAnexo({ component_list: [linhaA(2, true), linhaB(1)] }),
      ),
    );
    expect(anexoPrincipal.message).toContain('congelado');
    const doisPrincipais: ShopeeUpdateKitItemRequest = {
      item_id: KIT,
      item_setting: {
        model_list: [
          atualizacaoParcial().item_setting!.model_list![0]!,
          {
            model_id: MODELO_KIT_2,
            tier_index: [1],
            component_list: [linhaA(2, true), linhaB(1)],
          },
        ],
      },
    };
    expect(aceita(() => assertUpdateKitItemRequest(doisPrincipais))).toBe(false);
    // Nenhum principal na lista enviada é legal: o principal vive no modelo omitido.
    expect(
      aceita(() =>
        assertUpdateKitItemRequest({
          item_id: KIT,
          item_setting: {
            model_list: [
              { model_id: MODELO_KIT_2, tier_index: [1], component_list: [linhaA(2), linhaB(1)] },
            ],
          },
        }),
      ),
    ).toBe(true);
  });

  it('o corpo precisa MUDAR algo — contado sobre VALORES definidos, nunca sobre chaves', () => {
    expect(aceita(() => assertUpdateKitItemRequest({ item_id: KIT }))).toBe(false);
    expect(aceita(() => assertUpdateKitItemRequest({ item_id: KIT, item_setting: {} }))).toBe(
      false,
    );
    expect(
      aceita(() =>
        assertUpdateKitItemRequest({ item_id: KIT, item_setting: { item_name: undefined } }),
      ),
    ).toBe(false);
    expect(
      aceita(() =>
        assertUpdateKitItemRequest({ item_id: KIT, sync_setting: { auto_sync_dts: true } }),
      ),
    ).toBe(true);
    expect(
      aceita(() =>
        assertUpdateKitItemRequest({ item_id: KIT, item_setting: { item_name: 'Novo' } }),
      ),
    ).toBe(true);
    for (const id of [0, -1, 1.5]) {
      expect(
        aceita(() => assertUpdateKitItemRequest({ ...atualizacaoParcial(), item_id: id })),
        String(id),
      ).toBe(false);
    }
  });

  it('modelos: 1…9, sem model_id > 0 repetido, sem tier_index repetido, dentro do tier quando ele vem', () => {
    // Só preço — nenhuma linha, então nenhum principal interfere na contagem.
    const base: ShopeeUpdateKitModelRequest = {
      model_id: MODELO_KIT,
      tier_index: [0],
      original_price: 39.9,
    };
    const lista = (
      model_list: readonly ShopeeUpdateKitModelRequest[],
    ): ShopeeUpdateKitItemRequest => ({
      item_id: KIT,
      item_setting: { model_list },
    });
    expect(aceita(() => assertUpdateKitItemRequest(lista([])))).toBe(false);
    // O MESMO model_id duas vezes cai…
    expect(
      aceita(() => assertUpdateKitItemRequest(lista([base, { ...base, tier_index: [1] }]))),
    ).toBe(false);
    // …a MESMA opção duas vezes cai…
    expect(
      aceita(() => assertUpdateKitItemRequest(lista([base, { ...base, model_id: MODELO_KIT_2 }]))),
    ).toBe(false);
    // …e o quase-igual (ids e opções distintos) passa.
    expect(
      aceita(() =>
        assertUpdateKitItemRequest(
          lista([base, { ...base, model_id: MODELO_KIT_2, tier_index: [1] }]),
        ),
      ),
    ).toBe(true);
    // Dois ANEXOS (`0` duas vezes) não são um id repetido — `0` é a sentinela.
    expect(
      aceita(() =>
        assertUpdateKitItemRequest({
          item_id: KIT,
          item_setting: {
            model_list: [
              {
                model_id: 0,
                tier_index: [1],
                original_price: 10,
                component_list: [linhaA(1), linhaB(1)],
              },
              { model_id: 0, tier_index: [2], original_price: 10, component_list: [linhaA(2)] },
            ],
            tier_variation_list: tierDe(3),
          },
        }),
      ),
    ).toBe(true);
    // Fora do tier declarado.
    expect(
      aceita(() =>
        assertUpdateKitItemRequest({
          item_id: KIT,
          item_setting: {
            model_list: [{ ...base, tier_index: [2] }],
            tier_variation_list: [
              { name: 'Tamanho', option_list: [{ option: 'P' }, { option: 'M' }] },
            ],
          },
        }),
      ),
    ).toBe(false);
    // Dez modelos caem.
    const dez = Array.from({ length: 10 }, (_, i) => ({
      model_id: MODELO_KIT + i,
      tier_index: [i] as const,
      original_price: 10,
    }));
    expect(
      aceita(() => assertUpdateKitItemRequest({ item_id: KIT, item_setting: { model_list: dez } })),
    ).toBe(false);
    // Um model_id negativo cai; `0` é o anexo.
    expect(aceita(() => assertUpdateKitItemRequest(atualizacaoParcial({ model_id: -1 })))).toBe(
      false,
    );
  });

  it('M33 no update também: `component_model_id: 0` cai; cada campo presente passa a regra da criação', () => {
    expect(
      aceita(() =>
        assertUpdateKitItemRequest(
          atualizacaoParcial({
            component_list: [
              linhaA(1, true),
              { component_item_id: ITEM_B, component_model_id: 0, quantity: 1 },
            ],
          }),
        ),
      ),
    ).toBe(false);
    const ids = (n: number): string[] =>
      Array.from({ length: n }, (_, i) => `${IMAGEM}-${String(i)}`);
    expect(
      aceita(() =>
        assertUpdateKitItemRequest({
          item_id: KIT,
          item_setting: { images: { image_id_list: ids(10) } },
        }),
      ),
    ).toBe(true);
    expect(
      aceita(() =>
        assertUpdateKitItemRequest({
          item_id: KIT,
          item_setting: { images: { image_id_list: ids(11) } },
        }),
      ),
    ).toBe(false);
    expect(
      aceita(() =>
        assertUpdateKitItemRequest({ item_id: KIT, item_setting: { logistic_info: [] } }),
      ),
    ).toBe(false);
    expect(
      aceita(() => assertUpdateKitItemRequest({ item_id: KIT, item_setting: { weight: 0 } })),
    ).toBe(false);
    expect(
      aceita(() => assertUpdateKitItemRequest({ item_id: KIT, item_setting: { item_name: ' ' } })),
    ).toBe(false);
    expect(
      aceita(() => assertUpdateKitItemRequest(atualizacaoParcial({ original_price: 39.999 }))),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('assertGenerateKitImageParams — 2…9 pares, modelId OBRIGATÓRIO', () => {
  const par = (i: number): { itemId: number; modelId: number } => ({
    itemId: ITEM_A + i,
    modelId: MODELO_A + i,
  });
  const com = (n: number): GenerateKitImageParams => ({
    componentes: Array.from({ length: n }, (_, i) => par(i)),
  });

  it('2 e 9 passam; 1 e 10 caem (a sonda: "between 2 and 9 items, inclusive")', () => {
    expect(aceita(() => assertGenerateKitImageParams(com(2)))).toBe(true);
    expect(aceita(() => assertGenerateKitImageParams(com(9)))).toBe(true);
    expect(aceita(() => assertGenerateKitImageParams(com(1)))).toBe(false);
    expect(aceita(() => assertGenerateKitImageParams(com(10)))).toBe(false);
  });

  it('modelId ausente, 0 ou negativo cai ("ModelId is required"); par repetido cai', () => {
    const semModelo = {
      componentes: [par(0), { itemId: ITEM_B }],
    } as unknown as GenerateKitImageParams;
    expect(recusa(() => assertGenerateKitImageParams(semModelo)).message).toContain(
      'componentes[1].modelId',
    );
    expect(
      aceita(() =>
        assertGenerateKitImageParams({ componentes: [par(0), { itemId: ITEM_B, modelId: 0 }] }),
      ),
    ).toBe(false);
    expect(
      aceita(() =>
        assertGenerateKitImageParams({
          componentes: [par(0), { itemId: 0, modelId: MODELO_OCULTO_B }],
        }),
      ),
    ).toBe(false);
    // O id OCULTO de um item sem variações é um modelId legítimo.
    expect(
      aceita(() =>
        assertGenerateKitImageParams({
          componentes: [par(0), { itemId: ITEM_B, modelId: MODELO_OCULTO_B }],
        }),
      ),
    ).toBe(true);
    expect(aceita(() => assertGenerateKitImageParams({ componentes: [par(0), par(0)] }))).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('linhasDeReenvioDoKit — a ÚNICA cópia fio→fio de um modelo vivo', () => {
  /** Um modelo vivo, como o SCHEMA de `get_kit_item_info` o entrega (o leitor real). */
  const modeloVivo = shopeeKitModelSchema.parse({
    model_id: MODELO_KIT,
    model_sku: '',
    original_price: 49.9,
    tier_index: [0],
    component_list: [
      {
        component_item_id: ITEM_A,
        component_item_name: 'Componente A',
        component_model_id: MODELO_A,
        component_model_name: 'P',
        quantity: 1,
        main_component: true,
        component_item_or_model_image: IMAGEM,
        component_item_or_model_sku: 'A-P',
      },
      {
        // ⚠️ Item SEM variações: a leitura devolve o id OCULTO, não-zero, com nome e sku vazios.
        component_item_id: ITEM_B,
        component_item_name: 'Componente B',
        component_model_id: MODELO_OCULTO_B,
        component_model_name: '',
        quantity: 2,
        main_component: false,
        component_item_or_model_image: IMAGEM,
        component_item_or_model_sku: '',
      },
    ],
  });

  it('M41 — reenvia o id OCULTO verbatim, a quantidade lida, e `main_component` só quando leu true', () => {
    expect(linhasDeReenvioDoKit(modeloVivo)).toStrictEqual([
      {
        component_item_id: ITEM_A,
        component_model_id: MODELO_A,
        quantity: 1,
        main_component: true,
      },
      { component_item_id: ITEM_B, component_model_id: MODELO_OCULTO_B, quantity: 2 },
    ]);
  });

  it('M41 — `component_model_id` 0 ou ausente OMITE a chave (nunca emite 0); main false/ausente omite', () => {
    const modelo = shopeeKitModelSchema.parse({
      model_id: MODELO_KIT,
      tier_index: [0],
      component_list: [
        { component_item_id: ITEM_A, component_model_id: 0, quantity: 1, main_component: null },
        { component_item_id: ITEM_B, quantity: 2 },
      ],
    });
    const linhas = linhasDeReenvioDoKit(modelo);
    expect(linhas).toHaveLength(2);
    for (const linha of linhas) {
      expect('component_model_id' in linha).toBe(false);
      expect('main_component' in linha).toBe(false);
    }
    expect(JSON.stringify(linhas)).not.toContain('component_model_id');
  });

  it('a ORDEM das linhas é a da leitura (verbatim), e uma quantidade que não veio é recusada, nunca inventada', () => {
    const invertido = shopeeKitModelSchema.parse({
      model_id: MODELO_KIT,
      tier_index: [0],
      component_list: [
        { component_item_id: ITEM_B, component_model_id: MODELO_OCULTO_B, quantity: 2 },
        {
          component_item_id: ITEM_A,
          component_model_id: MODELO_A,
          quantity: 1,
          main_component: true,
        },
      ],
    });
    expect(linhasDeReenvioDoKit(invertido).map((l) => l.component_item_id)).toStrictEqual([
      ITEM_B,
      ITEM_A,
    ]);

    const semQuantidade = shopeeKitModelSchema.parse({
      model_id: MODELO_KIT,
      tier_index: [0],
      component_list: [{ component_item_id: ITEM_A, component_model_id: MODELO_A }],
    });
    expect(recusa(() => linhasDeReenvioDoKit(semQuantidade)).message).toContain('quantity');
  });

  it('IDA E VOLTA: o leitor real → a cópia → o guarda do update aceita o corpo parcial de P2-c', () => {
    const corpo: ShopeeUpdateKitItemRequest = {
      item_id: KIT,
      item_setting: {
        model_list: [
          {
            model_id: MODELO_KIT,
            tier_index: [modeloVivo.tier_index[0]!],
            original_price: 44.9,
            component_list: linhasDeReenvioDoKit(modeloVivo),
          },
        ],
      },
    };
    expect(aceita(() => assertUpdateKitItemRequest(corpo))).toBe(true);
    // E o id oculto de B atravessa até o corpo que vai ao fio.
    expect(JSON.stringify(corpo)).toContain(`"component_model_id":${String(MODELO_OCULTO_B)}`);
  });
});

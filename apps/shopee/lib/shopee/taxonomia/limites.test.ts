import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_GET_VARIATIONS_PATH,
  ShopeeNetworkError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';

import { type ShopeeTaxonomiaCtx, __setShopeeTaxonomiaClockForTests } from './cache';
import {
  faixa,
  lerLimitesDeItem,
  lerLimitesDeKit,
  limitesDeItemDtoSchema,
  limitesDeKitDtoSchema,
  suportaPreVenda,
} from './limites';

function banda(v: Partial<Record<'min_limit' | 'max_limit' | 'min' | 'max', number | null>>) {
  return { min_limit: null, max_limit: null, min: null, max: null, ...v };
}

function ctxCom(seams: { item?: () => Promise<unknown>; kit?: () => Promise<unknown> }): {
  chamadas: { item: number; kit: number };
  ctx: ShopeeTaxonomiaCtx;
} {
  const chamadas = { item: 0, kit: 0 };
  const client = {
    getItemLimit: async () => {
      chamadas.item += 1;
      return seams.item === undefined ? { response: {}, gtin_limit: null } : seams.item();
    },
    getKitItemLimit: async () => {
      chamadas.kit += 1;
      return seams.kit === undefined ? {} : seams.kit();
    },
  } as unknown as ShopeeClient;
  return {
    chamadas,
    ctx: { integracaoId: 'int-1', client, variationsPath: SHOPEE_GET_VARIATIONS_PATH },
  };
}

beforeEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
});

describe('faixa lê as DUAS grafias da banda', () => {
  it.each([
    ['min_limit/max_limit', banda({ min_limit: 1, max_limit: 30 }), { min: 1, max: 30 }],
    ['min/max', banda({ min: 1, max: 30 }), { min: 1, max: 30 }],
    ['as duas, com min_limit ganhando', banda({ min_limit: 5, min: 1 }), { min: 5, max: null }],
    ['só a metade de cima', banda({ max_limit: 99 }), { min: null, max: 99 }],
  ])('com %s', (_caso, entrada, esperado) => {
    expect(faixa(entrada)).toEqual(esperado);
  });

  it('mantém min_limit 0 — `??` e nunca `||`', () => {
    // Com `||`, um piso de 0 cairia para `min` e a resposta diria "sem piso".
    expect(faixa(banda({ min_limit: 0, min: 7 }))).toEqual({ min: 0, max: null });
  });

  it('uma banda ausente é null, não uma banda vazia', () => {
    expect(faixa(null)).toBeNull();
    expect(faixa(undefined)).toBeNull();
  });
});

describe('suportaPreVenda lê o sentinela -1', () => {
  it('uma janela de verdade responde true', () => {
    expect(suportaPreVenda({ days_to_ship_limit: banda({ min_limit: 1, max_limit: 30 }) })).toBe(
      true,
    );
  });

  it.each([
    ['-1 no topo', banda({ min_limit: 1, max_limit: -1 })],
    ['-1 na base', banda({ min_limit: -1, max_limit: 30 })],
    ['0 no topo', banda({ min_limit: 0, max_limit: 0 })],
    ['uma banda sem números', banda({})],
  ])('%s responde false', (_caso, dts) => {
    expect(suportaPreVenda({ days_to_ship_limit: dts })).toBe(false);
  });

  it('sem dts_limit responde false — o default seguro', () => {
    // Prometer pré-venda que a loja não tem faz a publicação ser recusada por um
    // campo que ninguém preencheu; o contrário só deixa de oferecer prazo longo.
    expect(suportaPreVenda(null)).toBe(false);
    expect(suportaPreVenda({ days_to_ship_limit: null })).toBe(false);
  });
});

describe('lerLimitesDeItem', () => {
  it.each([
    ['só DENTRO de response', { dentro: 'MANDATORY', irmao: null }, 'MANDATORY'],
    ['só como IRMÃO de response', { dentro: null, irmao: 'OPTIONAL' }, 'OPTIONAL'],
    ['nas DUAS, com a de dentro ganhando', { dentro: 'MANDATORY', irmao: 'OPTIONAL' }, 'MANDATORY'],
    ['em NENHUMA das duas', { dentro: null, irmao: null }, null],
  ])('lê gtin_limit %s', async (_caso, posicoes, esperado) => {
    // A página desenha `gtin_limit` FORA de `response` e não traz sample de
    // resposta: qual posição a API viva preenche é indefinido, então as duas são
    // declaradas e o merge acontece aqui, onde dá para observar.
    const { ctx } = ctxCom({
      item: async () => ({
        response: {
          gtin_limit: posicoes.dentro === null ? null : { gtin_validation_rule: posicoes.dentro },
        },
        gtin_limit: posicoes.irmao === null ? null : { gtin_validation_rule: posicoes.irmao },
      }),
    });

    const { gtinLimit } = await lerLimitesDeItem(ctx, 100182);
    if (esperado === null) {
      // `null`, JAMAIS `{}`: "Shopee não respondeu sobre GTIN" e "Shopee
      // respondeu e não disse nada" são afirmações diferentes.
      expect(gtinLimit).toBeNull();
    } else {
      expect(gtinLimit).toEqual({ gtinValidationRule: esperado });
    }
  });

  it('preserva a banda crua com -1 ao lado de supportsPreOrder false', async () => {
    const { ctx } = ctxCom({
      item: async () => ({
        response: {
          dts_limit: {
            days_to_ship_limit: banda({ min_limit: 1, max_limit: -1 }),
            non_pre_order_days_to_ship: 3,
          },
        },
        gtin_limit: null,
      }),
    });

    const { limites, supportsPreOrder } = await lerLimitesDeItem(ctx, 100182);
    expect(supportsPreOrder).toBe(false);
    // O -1 continua visível: quem consome pode ver o sentinela por si mesmo.
    expect(limites.dtsLimit).toEqual({
      daysToShipLimit: { min: 1, max: -1 },
      nonPreOrderDaysToShip: 3,
    });
    expect(() => limitesDeItemDtoSchema.parse(limites)).not.toThrow();
  });

  it('projeta as bandas do item com as chaves camelCase de Shopee', async () => {
    const { ctx } = ctxCom({
      item: async () => ({
        response: {
          price_limit: banda({ min_limit: 1.5, max_limit: 9999.99 }),
          stock_limit: banda({ min_limit: 0, max_limit: 999 }),
          size_chart_limit: {
            size_chart_mandatory: true,
            support_image_size_chart: false,
            support_template_size_chart: null,
          },
          weight_limit: { weight_mandatory: true },
          dimension_limit: { dimension_mandatory: false },
        },
        gtin_limit: null,
      }),
    });

    const { limites } = await lerLimitesDeItem(ctx, 100182);
    expect(limites.priceLimit).toEqual({ min: 1.5, max: 9999.99 });
    expect(limites.stockLimit).toEqual({ min: 0, max: 999 });
    expect(limites.sizeChartLimit).toEqual({
      sizeChartMandatory: true,
      supportImageSizeChart: false,
      supportTemplateSizeChart: null,
    });
    expect(limites.weightLimit).toEqual({ weightMandatory: true });
    expect(limites.dimensionLimit).toEqual({ dimensionMandatory: false });
    expect(() => limitesDeItemDtoSchema.parse(limites)).not.toThrow();
  });

  it('uma falha do provedor SOBE — nunca vira limites nulos', async () => {
    // Quem recebesse `null` publicaria com números chutados, que é exatamente a
    // falha que esta camada existe para impedir.
    const { ctx } = ctxCom({
      item: async () => {
        throw new ShopeeNetworkError('fetch falhou');
      },
    });

    await expect(lerLimitesDeItem(ctx, 100182)).rejects.toBeInstanceOf(ShopeeNetworkError);
  });
});

describe('lerLimitesDeKit', () => {
  it('chama get_kit_item_limit e NUNCA get_item_limit', async () => {
    // As duas páginas discordam campo a campo; derivar as bandas do kit das do
    // item publica um kit contra um teto que não é o dele.
    const { chamadas, ctx } = ctxCom({ kit: async () => ({}) });

    await lerLimitesDeKit(ctx, 100182);
    expect(chamadas.kit).toBe(1);
    expect(chamadas.item).toBe(0);
  });

  it('projeta os campos que SÓ o kit declara', async () => {
    const { ctx } = ctxCom({
      kit: async () => ({
        description_limit: {
          description_length_min: 5,
          description_length_max: 3000,
          description_text_length_min: 1,
          description_text_length_max: 2000,
          description_image_num_min: 0,
          description_image_num_max: 9,
          description_image_width_min: 300,
          description_image_height_min: 300,
          description_image_aspect_ratio_min: 0.5,
          description_image_aspect_ratio_max: 2,
        },
        dts_limit: {
          non_pre_order_days_to_ship: 2,
          support_pre_order: false,
          days_to_ship_limit: banda({ min_limit: 1, max_limit: 30 }),
        },
        component_count_limit_of_single_model: banda({ min_limit: 2, max_limit: 10 }),
      }),
    });

    const limites = await lerLimitesDeKit(ctx, 100182);
    expect(limites.descriptionLimit).toMatchObject({
      descriptionLengthMin: 5,
      descriptionLengthMax: 3000,
    });
    // ⚠️ O boolean PRÓPRIO de Shopee, e não o `supportsPreOrder` que a rota de
    // item deriva do sentinela: a banda aqui é positiva e mesmo assim o campo é
    // `false`, porque quem responde é a página, não a dedução.
    expect(limites.dtsLimit).toEqual({
      nonPreOrderDaysToShip: 2,
      supportPreOrder: false,
      daysToShipLimit: { min: 1, max: 30 },
    });
    expect(limites.componentCountLimitOfSingleModel).toEqual({ min: 2, max: 10 });
    expect(() => limitesDeKitDtoSchema.parse(limites)).not.toThrow();
  });

  it('não inventa campos quando a página responde vazio', async () => {
    const { ctx } = ctxCom({ kit: async () => ({}) });

    const limites = await lerLimitesDeKit(ctx, null);
    expect(limites.descriptionLimit).toBeNull();
    expect(limites.dtsLimit).toBeNull();
    expect(limites.componentCountLimitOfSingleModel).toBeNull();
  });
});

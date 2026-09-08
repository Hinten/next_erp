import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_GET_VARIATIONS_PATH,
  ShopeeNetworkError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';

import { type ShopeeTaxonomiaCtx, __setShopeeTaxonomiaClockForTests } from './cache';
import { lerVariacoes } from './variacoes';

function ctxCom(getVariations: () => Promise<unknown>) {
  const chamadas: Array<{ categoryId: number }> = [];
  const client = {
    getVariations: async (p: { categoryId: number }) => {
      chamadas.push(p);
      return getVariations();
    },
  } as unknown as ShopeeClient;
  const ctx: ShopeeTaxonomiaCtx = {
    integracaoId: 'int-1',
    client,
    variationsPath: SHOPEE_GET_VARIATIONS_PATH,
  };
  return { chamadas, ctx };
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

describe('lerVariacoes', () => {
  it('projeta os três níveis e preserva variation_option_id 0', async () => {
    // O `0` é a opção CUSTOM observada: quem o lê como ausência derruba
    // exatamente a opção que o operador digitou à mão.
    const { ctx } = ctxCom(async () => ({
      standardise_variation_list: [
        {
          variation_id: 100012345678901,
          variation_name: 'Tamanho',
          variation_group_list: [
            {
              variation_group_id: 200000000000001,
              variation_group_name: 'Numérico',
              variation_option_list: [
                { variation_option_id: 0, variation_option_name: 'Personalizado' },
                { variation_option_id: 300000000000001, variation_option_name: 'P' },
              ],
            },
          ],
        },
      ],
    }));

    const lidas = await lerVariacoes(ctx, 100182);
    expect(lidas.categoryId).toBe(100182);
    expect(
      lidas.standardiseVariationList[0]?.variationGroupList[0]?.variationOptionList.map(
        (o) => o.variationOptionId,
      ),
    ).toEqual([0, 300000000000001]);
  });

  it('uma categoria sem variações padronizadas responde uma lista vazia', async () => {
    const { ctx } = ctxCom(async () => ({ standardise_variation_list: [] }));

    await expect(lerVariacoes(ctx, 100182)).resolves.toEqual({
      categoryId: 100182,
      standardiseVariationList: [],
    });
  });

  it('pede exatamente a categoria recebida', async () => {
    const { chamadas, ctx } = ctxCom(async () => ({ standardise_variation_list: [] }));

    await lerVariacoes(ctx, 100182);
    expect(chamadas).toEqual([{ categoryId: 100182 }]);
  });

  it('deixa uma falha do provedor subir', async () => {
    const { ctx } = ctxCom(async () => {
      throw new ShopeeNetworkError('fetch falhou');
    });

    await expect(lerVariacoes(ctx, 100182)).rejects.toBeInstanceOf(ShopeeNetworkError);
  });
});

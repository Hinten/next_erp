import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { SHOPEE_GET_VARIATIONS_PATH, type ShopeeClient } from '@delfrance/integrations-shopee';

import { type ShopeeTaxonomiaCtx, __setShopeeTaxonomiaClockForTests } from './cache';
import { lerPaginaDeMarcas, paginaDeMarcasVazia } from './marcas';

const PEDIDO = { categoryId: 100182, status: 1, offset: 0, pageSize: 100 };

function ctxCom(pagina: Record<string, unknown>) {
  const chamadas: Array<Record<string, unknown>> = [];
  const client = {
    getBrandList: async (p: Record<string, unknown>) => {
      chamadas.push(p);
      return pagina;
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

describe('lerPaginaDeMarcas', () => {
  it('mantém brand_id 0 ("Sem marca") como um valor da página', async () => {
    const { ctx } = ctxCom({
      brand_list: [
        { brand_id: 0, original_brand_name: 'No Brand', display_brand_name: null },
        { brand_id: 2500139861, original_brand_name: 'Hering', display_brand_name: 'Hering' },
      ],
      has_next_page: false,
      next_offset: null,
      is_mandatory: true,
      input_type: 'DROP_DOWN',
    });

    const pagina = await lerPaginaDeMarcas(ctx, PEDIDO);
    expect(pagina.marcas.map((m) => m.brandId)).toEqual([0, 2500139861]);
    expect(pagina.isMandatory).toBe(true);
    expect(pagina.inputType).toBe('DROP_DOWN');
  });

  it('ecoa next_offset VERBATIM, sem recalcular offset + pageSize', async () => {
    // O cursor é de Shopee. Calcular `0 + 100 = 100` daria o mesmo número neste
    // caso e um número errado no dia em que a página vier menor que o pedido.
    const { ctx } = ctxCom({
      brand_list: [],
      has_next_page: true,
      next_offset: 37,
      is_mandatory: null,
      input_type: null,
    });

    const pagina = await lerPaginaDeMarcas(ctx, PEDIDO);
    expect(pagina.nextOffset).toBe(37);
    expect(pagina.hasNextPage).toBe(true);
  });

  it('NÃO pagina sozinha: has_next_page true e ainda assim UMA chamada', async () => {
    const { chamadas, ctx } = ctxCom({
      brand_list: [],
      has_next_page: true,
      next_offset: 100,
      is_mandatory: null,
      input_type: null,
    });

    await lerPaginaDeMarcas(ctx, PEDIDO);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toEqual({
      categoryId: 100182,
      offset: 0,
      pageSize: 100,
      status: 1,
    });
  });
});

describe('paginaDeMarcasVazia', () => {
  it('tem exatamente as mesmas chaves de uma página de verdade', async () => {
    // As duas respostas chegam ao mesmo renderizador; se as formas divergirem,
    // quem consome precisa saber qual ramo produziu a resposta.
    const { ctx } = ctxCom({
      brand_list: [],
      has_next_page: false,
      next_offset: null,
      is_mandatory: null,
      input_type: null,
    });

    const real = await lerPaginaDeMarcas(ctx, PEDIDO);
    expect(Object.keys(paginaDeMarcasVazia(PEDIDO)).sort()).toEqual(Object.keys(real).sort());
  });

  it('devolve o pedido ecoado e nenhuma marca', () => {
    const vazia = paginaDeMarcasVazia({ categoryId: 100100, status: 2, offset: 50, pageSize: 25 });
    expect(vazia).toEqual({
      categoryId: 100100,
      status: 2,
      offset: 50,
      pageSize: 25,
      marcas: [],
      hasNextPage: false,
      nextOffset: null,
      isMandatory: null,
      inputType: null,
    });
  });
});

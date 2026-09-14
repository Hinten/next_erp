import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_VARIATIONS_PATH,
  ShopeeApiError,
  ShopeeNetworkError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';

import { avisoDeShopee, lerAtributos } from './atributos';
import { type ShopeeTaxonomiaCtx, __setShopeeTaxonomiaClockForTests } from './cache';

function linha(category_id: number, warning: string | null = null, atributos = 0) {
  return {
    category_id,
    warning,
    attribute_tree: Array.from({ length: atributos }, (_v, i) => ({
      attribute_id: category_id * 10 + i,
      mandatory: true,
      name: `atributo-${String(i)}`,
      attribute_value_list: [],
      attribute_info: null,
      multi_lang: [],
    })),
  };
}

function ctxCom(getAttributeTree: (p: { categoryIds: readonly number[] }) => Promise<unknown>) {
  const chamadas: Array<readonly number[]> = [];
  const client = {
    getAttributeTree: async (p: { categoryIds: readonly number[] }) => {
      chamadas.push(p.categoryIds);
      return getAttributeTree(p);
    },
  } as unknown as ShopeeClient;
  const ctx: ShopeeTaxonomiaCtx = {
    integracaoId: 'int-1',
    client,
    variationsPath: SHOPEE_GET_VARIATIONS_PATH,
  };
  return { chamadas, ctx };
}

function erroDeApi(code: string): ShopeeApiError {
  return new ShopeeApiError(`Shopee respondeu ${code}`, {
    code,
    kind: SHOPEE_ERROR_KIND.other,
    httpStatus: 200,
    path: '/api/v2/product/get_attribute_tree',
  });
}

let spyWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  spyWarn.mockRestore();
});

describe('avisoDeShopee filtra por igualdade EXATA', () => {
  it.each([
    ['a string vazia', '', null],
    ['o "success" observado no sample', 'success', null],
    ['um aviso de verdade', 'brand is mandatory', 'brand is mandatory'],
    ['"Success" com maiúscula', 'Success', 'Success'],
    ['" success" com espaço', ' success', ' success'],
    ['"SUCCESS"', 'SUCCESS', 'SUCCESS'],
    ['ausência', null, null],
  ])('com %s responde o esperado', (_caso, entrada, esperado) => {
    // Sem trim e sem case fold: uma dobra aqui precisaria de entrada no
    // inventário de equivalências E escolheria o default errado — esconder um
    // aviso que Shopee escolheu mandar é a falha parcial que ninguém soube.
    expect(avisoDeShopee(entrada)).toBe(esperado);
  });
});

describe('lerAtributos escolhe a LINHA da categoria pedida', () => {
  it('não devolve list[0] quando a categoria pedida é a segunda', async () => {
    // Hoje o app pede uma categoria por chamada, então `list[0]` pareceria certo
    // para sempre — até o dia em que alguém pedir duas e toda resposta passar a
    // descrever a primeira.
    const { ctx } = ctxCom(async () => ({
      list: [linha(100200, null, 3), linha(100182, 'atenção', 1)],
    }));

    const lido = await lerAtributos(ctx, 100182);
    expect(lido.categoryId).toBe(100182);
    expect(lido.warning).toBe('atenção');
    expect(lido.atributos).toHaveLength(1);
  });

  it('uma lista sem a categoria pedida é "sem atributos", nunca a de outra', async () => {
    const { ctx } = ctxCom(async () => ({ list: [linha(100200, null, 3)] }));

    const lido = await lerAtributos(ctx, 100182);
    expect(lido.atributos).toEqual([]);
    expect(lido.warning).toBeNull();
  });

  it('uma lista vazia responde sem atributos e sem aviso', async () => {
    const { ctx } = ctxCom(async () => ({ list: [] }));

    await expect(lerAtributos(ctx, 100182)).resolves.toEqual({
      categoryId: 100182,
      warning: null,
      atributos: [],
    });
  });

  it('filtra o warning "success" da própria linha', async () => {
    const { ctx } = ctxCom(async () => ({ list: [linha(100182, 'success', 1)] }));
    await expect(lerAtributos(ctx, 100182)).resolves.toMatchObject({ warning: null });
  });

  it('envia UMA categoria por chamada', async () => {
    // Uma só serializa igual sob as duas grafias que a página contradiz
    // (`category_id_list` na tabela, `category_ids` no cURL).
    const { chamadas, ctx } = ctxCom(async () => ({ list: [linha(100182)] }));

    await lerAtributos(ctx, 100182);
    expect(chamadas).toEqual([[100182]]);
  });
});

describe('error_param é registrado CRU e relançado', () => {
  it.each([
    ['prefixado pelo módulo', 'product.error_param'],
    ['sem prefixo', 'error_param'],
  ])('com o código %s', async (_caso, code) => {
    const { ctx } = ctxCom(async () => {
      throw erroDeApi(code);
    });

    await expect(lerAtributos(ctx, 100182)).rejects.toBeInstanceOf(ShopeeApiError);
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(spyWarn.mock.calls[0]?.[1]).toMatchObject({
      categoryId: 100182,
      parametro: 'category_id_list',
      codigo: code,
    });
  });

  it('NÃO registra essa linha para outro erro de API — o par do caso acima', async () => {
    // O log existe para instrumentar UMA contradição; se disparasse em qualquer
    // falha, um `error_sign` viraria uma pista falsa sobre o nome do parâmetro.
    const { ctx } = ctxCom(async () => {
      throw erroDeApi('error_sign');
    });

    await expect(lerAtributos(ctx, 100182)).rejects.toBeInstanceOf(ShopeeApiError);
    expect(spyWarn).not.toHaveBeenCalled();
  });

  it('deixa passar um erro que não é da API (regra 6)', async () => {
    const { ctx } = ctxCom(async () => {
      throw new ShopeeNetworkError('fetch falhou');
    });

    await expect(lerAtributos(ctx, 100182)).rejects.toBeInstanceOf(ShopeeNetworkError);
    expect(spyWarn).not.toHaveBeenCalled();
  });
});

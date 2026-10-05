import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_GET_VARIATIONS_PATH,
  ShopeeNetworkError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';

import { type ShopeeTaxonomiaCtx, __setShopeeTaxonomiaClockForTests } from './cache';
import { lerRecomendacaoDeCategoria } from './recomendacao';

function categoria(category_id: number, parent_category_id: number, has_children: boolean) {
  return {
    category_id,
    parent_category_id,
    has_children,
    original_category_name: `cat-${String(category_id)}`,
    display_category_name: `cat-${String(category_id)}`,
  };
}

const ARVORE = [
  categoria(100000, 0, true),
  categoria(100100, 100000, true),
  categoria(100182, 100100, false),
];

function ctxCom(opcoes: { ids: readonly number[]; getCategory?: () => Promise<unknown> }): {
  chamadas: { arvore: number; recomendacao: number };
  ctx: ShopeeTaxonomiaCtx;
} {
  const chamadas = { arvore: 0, recomendacao: 0 };
  const client = {
    getCategory: async () => {
      chamadas.arvore += 1;
      return opcoes.getCategory === undefined ? { category_list: ARVORE } : opcoes.getCategory();
    },
    categoryRecommend: async () => {
      chamadas.recomendacao += 1;
      return { category_id: opcoes.ids };
    },
  } as unknown as ShopeeClient;
  return {
    chamadas,
    ctx: { integracaoId: 'int-1', client, variationsPath: SHOPEE_GET_VARIATIONS_PATH },
  };
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

describe('lerRecomendacaoDeCategoria', () => {
  it('numera as sugestões a partir de 1, na ordem em que Shopee mandou', async () => {
    // Nada aqui decide se a ordem é um ranking ou um caminho: `position` é o
    // índice em que o id chegou, e mais nada.
    const { ctx } = ctxCom({ ids: [100182, 100100] });

    const lida = await lerRecomendacaoDeCategoria(ctx, 'camiseta lisa', null);
    expect(lida.recomendacoes.map((r) => [r.position, r.categoryId])).toEqual([
      [1, 100182],
      [2, 100100],
    ]);
    expect(lida.unresolved).toBe(0);
  });

  it('decora cada linha com o caminho da raiz e o veredicto de folha', async () => {
    const { ctx } = ctxCom({ ids: [100182] });

    const [primeira] = (await lerRecomendacaoDeCategoria(ctx, 'camiseta', null)).recomendacoes;
    expect(primeira?.isLeaf).toBe(true);
    expect(primeira?.pathFromRoot.map((c) => c.categoryId)).toEqual([100000, 100100, 100182]);
    expect(spyWarn).not.toHaveBeenCalled();
  });

  it('degrada a LINHA cujo id não está na árvore, conta e avisa UMA vez', async () => {
    // Uma sugestão que Shopee devolveu vale mostrar mesmo sem decoração; falhar
    // a lista inteira jogaria fora as linhas que resolveram.
    const { ctx } = ctxCom({ ids: [100182, 999999, 888888] });

    const lida = await lerRecomendacaoDeCategoria(ctx, 'camiseta', null);
    expect(lida.unresolved).toBe(2);
    expect(lida.recomendacoes[1]).toEqual({
      position: 2,
      categoryId: 999999,
      name: null,
      // `null`, e não `false`: "não sei" não é "tem filhos".
      isLeaf: null,
      pathFromRoot: [],
    });
    // Uma linha de log para a leitura inteira, não uma por sugestão.
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(spyWarn.mock.calls[0]?.[1]).toMatchObject({ sugeridas: 3, naoResolvidas: 2 });
  });

  it('a falha da ÁRVORE sobe — o oposto da degradação por linha', async () => {
    // Não é o problema de uma linha: é a leitura de que toda a camada depende, e
    // escondê-la responderia uma lista inteira sem decoração enquanto a conta
    // está ilegível.
    const { ctx } = ctxCom({
      ids: [100182],
      getCategory: async () => {
        throw new ShopeeNetworkError('fetch falhou');
      },
    });

    await expect(lerRecomendacaoDeCategoria(ctx, 'camiseta', null)).rejects.toBeInstanceOf(
      ShopeeNetworkError,
    );
  });

  it('sem sugestão nenhuma NÃO lê a árvore', async () => {
    const { chamadas, ctx } = ctxCom({ ids: [] });

    await expect(lerRecomendacaoDeCategoria(ctx, 'nada', null)).resolves.toEqual({
      recomendacoes: [],
      unresolved: 0,
    });
    expect(chamadas.recomendacao).toBe(1);
    expect(chamadas.arvore).toBe(0);
  });
});

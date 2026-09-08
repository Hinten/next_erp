import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  READ_CACHE_DISABLED_ENV,
  READ_CACHE_TTL,
  __resetAllReadCaches,
  readCacheStatsSnapshot,
} from '@delfrance/data/admin/cache';
import {
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_GET_VARIATION_TREE_PATH_ALT,
  ShopeeConfigError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';

import type { ShopeeContext } from '../core/shopee';
import {
  type ShopeeTaxonomiaCtx,
  __setShopeeTaxonomiaClockForTests,
  lerAtributosCached,
  lerIndiceDeCategorias,
  lerLimitesItemCached,
  lerLimitesKitCached,
  lerMarcasCached,
  lerRecomendacaoCached,
  lerVariacoesCached,
  limparTaxonomiaShopee,
  taxonomiaCtx,
} from './cache';

/** Injected clock — a TTL boundary must be provable without sleeping. */
function relogio(inicio = 1_700_000_000_000) {
  let agora = inicio;
  return {
    now: (): number => agora,
    avancar: (ms: number): void => {
      agora += ms;
    },
  };
}

function categoria(category_id: number, parent_category_id = 0, has_children = false) {
  return {
    category_id,
    parent_category_id,
    has_children,
    original_category_name: `cat-${String(category_id)}`,
    display_category_name: `cat-${String(category_id)}`,
  };
}

/**
 * A client double that COUNTS every call, so "once per key per TTL window" is
 * assertable — and the counters are ALSO what proves "int-2 never serves int-1",
 * because a conta served from another's entry calls its own client zero times.
 *
 * ⚠️ The returned VALUES cannot carry that proof on their own: only
 * `getAttributeTree` (`warning`) and `getBrandList` (`input_type`) embed
 * `marca`; the other four answer from their argument alone, which is identical
 * for both contas. So a cross-conta test must assert BOTH sides' counters —
 * asserting one side's is a test that a leak leaves green.
 */
function clienteDuplo(marca: string) {
  const chamadas = {
    getCategory: 0,
    getAttributeTree: 0,
    getBrandList: 0,
    getItemLimit: 0,
    getKitItemLimit: 0,
    getVariations: 0,
    categoryRecommend: 0,
  };
  const client = {
    getCategory: async () => {
      chamadas.getCategory += 1;
      return { category_list: [categoria(100000), categoria(100182, 100000)] };
    },
    getAttributeTree: async (p: { categoryIds: readonly number[] }) => {
      chamadas.getAttributeTree += 1;
      return { list: [{ category_id: p.categoryIds[0], warning: marca, attribute_tree: [] }] };
    },
    getBrandList: async (p: { offset: number; pageSize: number; status: number }) => {
      chamadas.getBrandList += 1;
      return {
        brand_list: [],
        has_next_page: false,
        next_offset: p.offset,
        is_mandatory: null,
        input_type: `${marca}:${String(p.pageSize)}:${String(p.status)}`,
      };
    },
    getItemLimit: async (p: { categoryId?: number }) => {
      chamadas.getItemLimit += 1;
      return {
        response: { price_limit: { min_limit: p.categoryId ?? -1, max_limit: null } },
        gtin_limit: null,
      };
    },
    getKitItemLimit: async (p: { categoryId?: number }) => {
      chamadas.getKitItemLimit += 1;
      return { price_limit: { min_limit: p.categoryId ?? -1, max_limit: null } };
    },
    getVariations: async (p: { categoryId: number }) => {
      chamadas.getVariations += 1;
      return { standardise_variation_list: [{ variation_id: p.categoryId }] };
    },
    categoryRecommend: async (p: { itemName: string }) => {
      chamadas.categoryRecommend += 1;
      return { category_id: p.itemName === 'vazio' ? [] : [100182] };
    },
  };
  return { chamadas, client: client as unknown as ShopeeClient };
}

function ctxDuplo(integracaoId = 'int-1', marca = integracaoId) {
  const { chamadas, client } = clienteDuplo(marca);
  const ctx: ShopeeTaxonomiaCtx = {
    integracaoId,
    client,
    variationsPath: SHOPEE_GET_VARIATIONS_PATH,
  };
  return { chamadas, ctx };
}

function estatisticas(nome: string) {
  return readCacheStatsSnapshot().find((s) => s.name === nome);
}

let clock: ReturnType<typeof relogio>;

beforeEach(() => {
  clock = relogio();
  // Suites share one process and every test below uses `int-1`: without this the
  // previous test's tree serves this one and every zero-call assertion lies.
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests(clock.now);
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('a janela de TTL', () => {
  it('serve do cache até um milissegundo antes do TTL e relê no TTL exato', async () => {
    const { chamadas, ctx } = ctxDuplo();

    await lerIndiceDeCategorias(ctx);
    clock.avancar(READ_CACHE_TTL.config - 1);
    await lerIndiceDeCategorias(ctx);
    // Primeira forma de medir: quantas vezes o provedor foi chamado.
    expect(chamadas.getCategory).toBe(1);
    // Segunda forma: o que o próprio cache contabilizou. Uma delas sozinha
    // passaria com um cache que devolve o valor certo pelo motivo errado.
    expect(estatisticas('shopee:taxonomia-categorias')).toMatchObject({ hits: 1, misses: 1 });

    clock.avancar(1);
    await lerIndiceDeCategorias(ctx);
    expect(chamadas.getCategory).toBe(2);
    expect(estatisticas('shopee:taxonomia-categorias')).toMatchObject({ hits: 1, misses: 2 });
  });
});

describe('uma leitura em voo é compartilhada', () => {
  it('chama o provedor UMA vez para três leituras concorrentes', async () => {
    let liberar!: () => void;
    const pendente = new Promise<void>((resolve) => {
      liberar = resolve;
    });
    let chamadas = 0;
    const client = {
      getCategory: async () => {
        chamadas += 1;
        await pendente;
        return { category_list: [categoria(100000)] };
      },
    } as unknown as ShopeeClient;
    const ctx: ShopeeTaxonomiaCtx = {
      integracaoId: 'int-1',
      client,
      variationsPath: SHOPEE_GET_VARIATIONS_PATH,
    };

    const todas = Promise.all([
      lerIndiceDeCategorias(ctx),
      lerIndiceDeCategorias(ctx),
      lerIndiceDeCategorias(ctx),
    ]);

    // SÍNCRONO, antes de liberar: depois do await a asserção não distinguiria
    // "uma leitura compartilhada" de "três leituras que já terminaram".
    expect(chamadas).toBe(1);
    expect(estatisticas('shopee:taxonomia-categorias')).toMatchObject({ inFlight: 1, size: 1 });

    liberar();
    const [a, b, c] = await todas;
    expect(chamadas).toBe(1);
    // A MESMA referência: nada rio abaixo pode mutar o que o cache devolve.
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

describe('a chave de desligamento', () => {
  it('com "1" toda leitura vai ao provedor', async () => {
    vi.stubEnv(READ_CACHE_DISABLED_ENV, '1');
    const { chamadas, ctx } = ctxDuplo();

    await lerIndiceDeCategorias(ctx);
    await lerIndiceDeCategorias(ctx);
    expect(chamadas.getCategory).toBe(2);
  });

  it('com "true" o cache continua ligado — o par do caso acima', async () => {
    // A válvula é `=== '1'`, e um valor plausível que não é ela NÃO pode
    // desligar nada por acidente.
    vi.stubEnv(READ_CACHE_DISABLED_ENV, 'true');
    const { chamadas, ctx } = ctxDuplo();

    await lerIndiceDeCategorias(ctx);
    await lerIndiceDeCategorias(ctx);
    expect(chamadas.getCategory).toBe(1);
  });
});

describe('toda chave começa pelo integracaoId', () => {
  it('duas contas são duas entradas e duas leituras', async () => {
    const um = ctxDuplo('int-1');
    const dois = ctxDuplo('int-2');

    await lerIndiceDeCategorias(um.ctx);
    await lerIndiceDeCategorias(dois.ctx);

    expect(um.chamadas.getCategory).toBe(1);
    expect(dois.chamadas.getCategory).toBe(1);
    expect(estatisticas('shopee:taxonomia-categorias')).toMatchObject({ size: 2, hits: 0 });
  });

  it('a árvore da int-2 NUNCA é servida para a int-1', async () => {
    // O erro que a chave existe para impedir não é "duas leituras a mais": é a
    // resposta de uma conta chegando à outra. Os dois clientes devolvem árvores
    // distinguíveis, então servir a errada é visível.
    const um = ctxDuplo('int-1');
    const dois = ctxDuplo('int-2');
    const client2 = {
      getCategory: async () => ({ category_list: [categoria(999999)] }),
    } as unknown as ShopeeClient;
    const ctx2: ShopeeTaxonomiaCtx = { ...dois.ctx, client: client2 };

    const a = await lerIndiceDeCategorias(um.ctx);
    const b = await lerIndiceDeCategorias(ctx2);

    expect([...a.porId.keys()]).toEqual([100000, 100182]);
    expect([...b.porId.keys()]).toEqual([999999]);
  });

  it.each([
    ['os atributos', async (ctx: ShopeeTaxonomiaCtx) => lerAtributosCached(ctx, 100182)],
    [
      'as marcas',
      async (ctx: ShopeeTaxonomiaCtx) =>
        lerMarcasCached(ctx, { categoryId: 100182, status: 1, offset: 0, pageSize: 100 }),
    ],
    ['os limites de item', async (ctx: ShopeeTaxonomiaCtx) => lerLimitesItemCached(ctx, 100182)],
    ['os limites de kit', async (ctx: ShopeeTaxonomiaCtx) => lerLimitesKitCached(ctx, 100182)],
    ['as variações', async (ctx: ShopeeTaxonomiaCtx) => lerVariacoesCached(ctx, 100182)],
    [
      'a recomendação',
      async (ctx: ShopeeTaxonomiaCtx) => lerRecomendacaoCached(ctx, 'camiseta', null),
    ],
  ])('%s de duas contas não se misturam', async (_caso, ler) => {
    const um = ctxDuplo('int-1');
    const dois = ctxDuplo('int-2');

    await ler(um.ctx);
    await ler(um.ctx);
    await ler(dois.ctx);

    // ⚠️ As DUAS pernas são obrigatórias, e a segunda é a que fala do vazamento.
    // Só a int-1 provaria apenas que o cache está vivo: se a chave perdesse o
    // integracaoId, a int-1 continuaria com exatamente uma leitura e a int-2
    // seria servida com a resposta dela — invisível deste lado.
    const somar = (c: (typeof um)['chamadas']) =>
      c.getAttributeTree +
      c.getBrandList +
      c.getItemLimit +
      c.getKitItemLimit +
      c.getVariations +
      c.categoryRecommend;

    // Uma leitura de provedor por conta, e a segunda leitura da int-1 veio do
    // cache — o par positivo que impede que este teste passe com um cache morto.
    expect(somar(um.chamadas)).toBe(1);
    // A int-2 pagou a PRÓPRIA leitura: nada da int-1 foi reaproveitado.
    expect(somar(dois.chamadas)).toBe(1);
  });
});

describe('a chave de uma página de marcas', () => {
  it.each([
    ['o offset', { categoryId: 100182, status: 1, offset: 100, pageSize: 100 }],
    ['o pageSize', { categoryId: 100182, status: 1, offset: 0, pageSize: 50 }],
    ['o status', { categoryId: 100182, status: 2, offset: 0, pageSize: 100 }],
    ['a categoria', { categoryId: 100200, status: 1, offset: 0, pageSize: 100 }],
  ])('distingue %s', async (_caso, segundo) => {
    const { chamadas, ctx } = ctxDuplo();
    const primeiro = { categoryId: 100182, status: 1, offset: 0, pageSize: 100 };

    await lerMarcasCached(ctx, primeiro);
    await lerMarcasCached(ctx, segundo);
    expect(chamadas.getBrandList).toBe(2);
  });

  it('reaproveita a MESMA página — o par positivo dos casos acima', async () => {
    // Sem este par, uma chave que nunca acerta passaria em todos eles.
    const { chamadas, ctx } = ctxDuplo();
    const pagina = { categoryId: 100182, status: 1, offset: 100, pageSize: 50 };

    await lerMarcasCached(ctx, pagina);
    await lerMarcasCached(ctx, { ...pagina });
    expect(chamadas.getBrandList).toBe(1);
  });
});

describe('os limites da loja inteira', () => {
  it('null (loja) e 0 não são a mesma chave', async () => {
    // `null` é a leitura documentada da loja inteira; `0` não é categoria
    // nenhuma. As duas chaves codificam diferente (`z:null` vs `n:0`), e é isso
    // que impede a resposta da loja de ser servida para uma categoria.
    const { chamadas, ctx } = ctxDuplo();

    await lerLimitesItemCached(ctx, null);
    await lerLimitesItemCached(ctx, 0);
    await lerLimitesItemCached(ctx, null);

    expect(chamadas.getItemLimit).toBe(2);
  });

  it('a leitura da loja omite category_id e a da categoria o envia', async () => {
    const enviados: Array<Record<string, unknown>> = [];
    const client = {
      getItemLimit: async (p: Record<string, unknown>) => {
        enviados.push(p);
        return { response: {}, gtin_limit: null };
      },
    } as unknown as ShopeeClient;
    const ctx: ShopeeTaxonomiaCtx = {
      integracaoId: 'int-1',
      client,
      variationsPath: SHOPEE_GET_VARIATIONS_PATH,
    };

    await lerLimitesItemCached(ctx, null);
    await lerLimitesItemCached(ctx, 100182);

    expect(enviados[0]).not.toHaveProperty('categoryId');
    expect(enviados[1]).toEqual({ categoryId: 100182 });
  });
});

describe('a recomendação não guarda o vazio', () => {
  it('uma lista vazia é relida a cada chamada', async () => {
    // `negativeTtlMs: 0`: um nome pela metade não pode deixar um "nenhuma
    // categoria" guardado para receber o nome inteiro.
    const { chamadas, ctx } = ctxDuplo();

    await lerRecomendacaoCached(ctx, 'vazio', null);
    await lerRecomendacaoCached(ctx, 'vazio', null);
    expect(chamadas.categoryRecommend).toBe(2);
  });

  it('uma lista com ids é guardada — o par do caso acima', async () => {
    const { chamadas, ctx } = ctxDuplo();

    await lerRecomendacaoCached(ctx, 'camiseta', null);
    await lerRecomendacaoCached(ctx, 'camiseta', null);
    expect(chamadas.categoryRecommend).toBe(1);
  });

  it('a imagem de capa faz parte da chave', async () => {
    const { chamadas, ctx } = ctxDuplo();

    await lerRecomendacaoCached(ctx, 'camiseta', null);
    await lerRecomendacaoCached(ctx, 'camiseta', 'img-1');
    expect(chamadas.categoryRecommend).toBe(2);
  });
});

describe('limparTaxonomiaShopee', () => {
  it('esvazia os SETE caches', async () => {
    // Grosso de propósito (o primitivo não varre por prefixo), mas grosso não
    // pode significar incompleto: um cache esquecido aqui seguiria servindo
    // dados velhos depois de um `push 13`.
    const { chamadas, ctx } = ctxDuplo();
    const ler = async (): Promise<void> => {
      await lerIndiceDeCategorias(ctx);
      await lerAtributosCached(ctx, 100182);
      await lerMarcasCached(ctx, { categoryId: 100182, status: 1, offset: 0, pageSize: 100 });
      await lerLimitesItemCached(ctx, 100182);
      await lerLimitesKitCached(ctx, 100182);
      await lerVariacoesCached(ctx, 100182);
      await lerRecomendacaoCached(ctx, 'camiseta', null);
    };

    await ler();
    await ler();
    expect(Object.values(chamadas)).toEqual([1, 1, 1, 1, 1, 1, 1]);

    limparTaxonomiaShopee();
    await ler();
    expect(Object.values(chamadas)).toEqual([2, 2, 2, 2, 2, 2, 2]);
  });
});

describe('taxonomiaCtx', () => {
  function contextoDuplo(variationsPath: string | null): ShopeeContext {
    return {
      integracaoId: 'int-1',
      conta: {} as ShopeeContext['conta'],
      config: { variationsPath } as ShopeeContext['config'],
      readCredential: async () => null,
      exchangeAndPersist: async () => undefined,
      getAccessToken: async () => 'at-1',
      createShopClient: () => ({}) as ShopeeClient,
    };
  }

  it('ecoa o caminho padrão de get_variations quando não há sobrescrita', () => {
    expect(taxonomiaCtx(contextoDuplo(null)).variationsPath).toBe(SHOPEE_GET_VARIATIONS_PATH);
  });

  it('ecoa a sobrescrita — é ela que vai dentro da base string do HMAC', () => {
    expect(taxonomiaCtx(contextoDuplo(SHOPEE_GET_VARIATION_TREE_PATH_ALT)).variationsPath).toBe(
      SHOPEE_GET_VARIATION_TREE_PATH_ALT,
    );
  });

  it('recusa uma sobrescrita que não é um caminho', () => {
    // Mesma função que o pacote usa na construção do cliente, então as duas não
    // podem discordar sobre um valor que ambas aceitaram.
    expect(() => taxonomiaCtx(contextoDuplo('https://api.example/api/v2/x'))).toThrow(
      ShopeeConfigError,
    );
  });
});

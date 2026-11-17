import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ShopeeNetworkError } from '@delfrance/integrations-shopee';
import { respostaBuscaCategoriasShopeeSchema } from '@delfrance/schemas';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { __setShopeeTaxonomiaClockForTests } from '@/lib/shopee/taxonomia/cache';

/**
 * The sibling `categorias/route.test.ts`'s doubles: admin auth and the Shopee
 * context loader are mocked, the taxonomy CACHES stay real (the search must
 * read the SAME cached index the drill-down reads), so both hooks reset them.
 */
const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getAccessToken: vi.fn(),
  getCategory: vi.fn(),
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => ({}),
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

const { GET } = await import('./route');

const READER = { uid: 'u1', permissions: PERM.integracao.read.toString() };

function categoria(
  category_id: number,
  parent_category_id: number,
  has_children: boolean,
  nome: string,
  original: string | null = null,
) {
  return {
    category_id,
    parent_category_id,
    has_children,
    original_category_name: original,
    display_category_name: nome,
  };
}

/**
 * 100000 Moda (raiz) → 100100 Camisetas e Blusas (com filhos) → 100182 Camiseta Básica (folha)
 * 100200 Calçados (folha, filha de 100000) · 200000 Casa (raiz, folha, original «Home»)
 */
const ARVORE = [
  categoria(100000, 0, true, 'Moda'),
  categoria(100100, 100000, true, 'Camisetas e Blusas'),
  categoria(100182, 100100, false, 'Camiseta Básica'),
  categoria(100200, 100000, false, 'Calçados'),
  categoria(200000, 0, false, 'Casa', 'Home'),
];

function req(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/taxonomia/categorias/busca');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers });
}

const AUTORIZADO = { authorization: 'Bearer t' };

function ctxDouble() {
  return {
    integracaoId: 'int-1',
    conta: { tipo: 5, shop_id: 987654, main_account_id: null },
    config: {
      partnerId: 1000001,
      partnerKey: 'chave-de-teste-nao-e-credencial',
      variationsPath: null,
    },
    readCredential: vi.fn(),
    getAccessToken: h.getAccessToken,
    createShopClient: () => ({
      async getCategory() {
        await h.getAccessToken();
        return h.getCategory();
      },
    }),
    exchangeAndPersist: vi.fn(),
  };
}

let spyWarn: ReturnType<typeof vi.spyOn>;
let spyErro: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.stubEnv(READ_CACHE_DISABLED_ENV, '');
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  spyErro = vi.spyOn(console, 'error').mockImplementation(() => {});
  h.verifyIdToken.mockResolvedValue(READER);
  h.loadCtx.mockResolvedValue(ctxDouble());
  h.getAccessToken.mockResolvedValue('at-1');
  h.getCategory.mockResolvedValue({ category_list: ARVORE });
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  spyWarn.mockRestore();
  spyErro.mockRestore();
});

async function buscar(q: string) {
  const res = await GET(req({ integracaoId: 'int-1', q }, AUTORIZADO));
  return { res, body: (await res.json()) as Record<string, unknown> };
}

function ids(body: Record<string, unknown>): number[] {
  return (body.resultados as Array<{ categoryId: number }>).map((c) => c.categoryId);
}

describe('GET taxonomia/categorias/busca — autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: 'int-1', q: 'moda' }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await GET(req({ integracaoId: 'int-1', q: 'moda' }, AUTORIZADO))).status).toBe(403);
  });

  it('responde 400 sem integracaoId, sem ler a árvore', async () => {
    const res = await GET(req({ q: 'moda' }, AUTORIZADO));
    expect(res.status).toBe(400);
    expect(h.getCategory).not.toHaveBeenCalled();
  });

  it('responde 400 sem q, sem ler a árvore', async () => {
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'q é obrigatório.' });
    expect(h.getCategory).not.toHaveBeenCalled();
  });

  it.each([
    ['em branco', '   '],
    ['de uma letra', ' a '],
    ['longa demais', 'x'.repeat(101)],
  ])('responde 400 para uma consulta %s, sem ler a árvore', async (_caso, q) => {
    const res = await GET(req({ integracaoId: 'int-1', q }, AUTORIZADO));
    expect(res.status).toBe(400);
    expect(h.getCategory).not.toHaveBeenCalled();
  });

  it('responde 404 para uma conta de outro tipo', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    expect((await GET(req({ integracaoId: 'int-1', q: 'moda' }, AUTORIZADO))).status).toBe(404);
  });
});

describe('a busca', () => {
  it('acha pelo nome sem acento nem caixa e devolve o caminho a partir da raiz', async () => {
    const { res, body } = await buscar('CALCADOS');

    expect(res.status).toBe(200);
    expect(body).toEqual({
      resultados: [
        {
          categoryId: 100200,
          name: 'Calçados',
          originalName: null,
          isLeaf: true,
          pathFromRoot: [
            { categoryId: 100000, name: 'Moda', originalName: null, isLeaf: false },
            { categoryId: 100200, name: 'Calçados', originalName: null, isLeaf: true },
          ],
        },
      ],
      truncated: false,
    });
  });

  it('folhas primeiro, depois os nós do meio', async () => {
    expect(ids((await buscar('camiseta')).body)).toEqual([100182, 100100]);
  });

  it('acha pelo nome original também', async () => {
    expect(ids((await buscar('home')).body)).toEqual([200000]);
  });

  it('o nome de um ANCESTRAL não faz o descendente casar', async () => {
    expect(ids((await buscar('moda')).body)).toEqual([100000]);
  });

  it('⚠️ QUASE: uma letra diferente não acha nada — resultados vazios é uma resposta', async () => {
    const { res, body } = await buscar('calcas');
    expect(res.status).toBe(200);
    expect(body).toEqual({ resultados: [], truncated: false });
  });

  it('a busca lê a MESMA árvore em cache — duas buscas, uma leitura de get_category', async () => {
    await buscar('moda');
    await buscar('casa');
    expect(h.getCategory).toHaveBeenCalledTimes(1);
  });

  it('uma falha de rede vira 503 pelo mapeador comum', async () => {
    h.getCategory.mockRejectedValue(new ShopeeNetworkError('fetch falhou'));
    expect((await buscar('moda')).res.status).toBe(503);
  });

  it('deixa um erro alheio subir em vez de engoli-lo (regra 6)', async () => {
    h.getCategory.mockRejectedValue(new TypeError('bug nosso'));
    await expect(GET(req({ integracaoId: 'int-1', q: 'moda' }, AUTORIZADO))).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe('o contrato compartilhado com apps/web', () => {
  it('o 200 volta IGUAL do schema compartilhado — nenhuma chave descartada', async () => {
    const { body } = await buscar('camiseta');
    expect(respostaBuscaCategoriasShopeeSchema.parse(body)).toEqual(body);
    expect(Object.keys(body).sort()).toEqual(
      Object.keys(respostaBuscaCategoriasShopeeSchema.shape).sort(),
    );
  });
});

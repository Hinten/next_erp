import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ShopeeNetworkError } from '@delfrance/integrations-shopee';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { __setShopeeTaxonomiaClockForTests } from '@/lib/shopee/taxonomia/cache';
import { categoriaResumoDtoSchema } from '@/lib/shopee/taxonomia/dto';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getAccessToken: vi.fn(),
  getCategory: vi.fn(),
  categoryRecommend: vi.fn(),
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
const AUTORIZADO = { authorization: 'Bearer t' };

const corpoSchema = z.object({
  recomendacoes: z.array(
    z.object({
      position: z.number().int(),
      categoryId: z.number().int(),
      name: z.string().nullable(),
      isLeaf: z.boolean().nullable(),
      pathFromRoot: z.array(categoriaResumoDtoSchema),
    }),
  ),
  unresolved: z.number().int(),
  applied: z.boolean(),
});

function categoria(category_id: number, parent_category_id: number, has_children: boolean) {
  return {
    category_id,
    parent_category_id,
    has_children,
    original_category_name: `orig-${String(category_id)}`,
    display_category_name: `cat-${String(category_id)}`,
  };
}

const ARVORE = [
  categoria(100000, 0, true),
  categoria(100100, 100000, true),
  categoria(100182, 100100, false),
];

function req(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL(
    'http://localhost:3009/api/marketplace/shopee/taxonomia/recomendacao-categoria',
  );
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers });
}

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
      async categoryRecommend(p: Record<string, unknown>) {
        await h.getAccessToken();
        return h.categoryRecommend(p);
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
  h.categoryRecommend.mockResolvedValue({ category_id: [100182, 100100] });
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  spyWarn.mockRestore();
  spyErro.mockRestore();
});

describe('GET taxonomia/recomendacao-categoria — autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: 'int-1', nome: 'camiseta' }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    const res = await GET(req({ integracaoId: 'int-1', nome: 'camiseta' }, AUTORIZADO));
    expect(res.status).toBe(403);
  });

  it('responde 400 sem integracaoId', async () => {
    expect((await GET(req({ nome: 'camiseta' }, AUTORIZADO))).status).toBe(400);
  });

  it.each([
    ['ausente', {}],
    ['vazio', { nome: '' }],
    ['só espaços', { nome: '   ' }],
  ])('responde 400 com o nome %s, sem chamar o provedor', async (_caso, extra) => {
    const res = await GET(req({ integracaoId: 'int-1', ...extra }, AUTORIZADO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'nome é obrigatório.' });
    expect(h.categoryRecommend).not.toHaveBeenCalled();
  });

  it('responde 404 para uma conta de outro tipo', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    const res = await GET(req({ integracaoId: 'int-1', nome: 'camiseta' }, AUTORIZADO));
    expect(res.status).toBe(404);
  });

  it('manda a imagem de capa como id, quando ela vem', async () => {
    await GET(req({ integracaoId: 'int-1', nome: 'camiseta', imagemCapa: 'img-123' }, AUTORIZADO));
    expect(h.categoryRecommend).toHaveBeenCalledWith({
      itemName: 'camiseta',
      productCoverImage: 'img-123',
    });
  });

  it('omite product_cover_image quando não há imagem', async () => {
    await GET(req({ integracaoId: 'int-1', nome: 'camiseta' }, AUTORIZADO));
    expect(h.categoryRecommend).toHaveBeenCalledWith({ itemName: 'camiseta' });
  });
});

describe('oferece, nunca aplica', () => {
  it('responde applied:false e nenhuma escrita', async () => {
    // #799: publicar aplicando `[0]` sem humano no meio só aparece quando o
    // anúncio já existe, na categoria errada, num marketplace vivo.
    const res = await GET(req({ integracaoId: 'int-1', nome: 'camiseta' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toHaveProperty('applied', false);
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('numera as posições a partir de 1 e decora cada linha', async () => {
    const res = await GET(req({ integracaoId: 'int-1', nome: 'camiseta' }, AUTORIZADO));
    const body = (await res.json()) as {
      recomendacoes: Array<Record<string, unknown>>;
      unresolved: number;
    };

    expect(body.recomendacoes.map((r) => r.position)).toEqual([1, 2]);
    expect(body.recomendacoes[0]).toMatchObject({ categoryId: 100182, isLeaf: true });
    expect(body).toHaveProperty('unresolved', 0);
  });
});

describe('a degradação por linha e a falha que sobe', () => {
  it('uma sugestão fora da árvore degrada a LINHA e conta unresolved', async () => {
    h.categoryRecommend.mockResolvedValue({ category_id: [100182, 999999] });
    const res = await GET(req({ integracaoId: 'int-1', nome: 'camiseta' }, AUTORIZADO));
    const body = (await res.json()) as {
      recomendacoes: Array<Record<string, unknown>>;
      unresolved: number;
    };

    expect(res.status).toBe(200);
    expect(body.unresolved).toBe(1);
    expect(body.recomendacoes[1]).toEqual({
      position: 2,
      categoryId: 999999,
      name: null,
      isLeaf: null,
      pathFromRoot: [],
    });
    expect(spyWarn).toHaveBeenCalledTimes(1);
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('a falha da ÁRVORE sobe como 503 — o oposto da degradação acima', async () => {
    h.getCategory.mockRejectedValue(new ShopeeNetworkError('fetch falhou'));
    const res = await GET(req({ integracaoId: 'int-1', nome: 'camiseta' }, AUTORIZADO));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_NETWORK_ERROR' });
  });

  it('sem sugestão nenhuma NÃO lê a árvore', async () => {
    h.categoryRecommend.mockResolvedValue({ category_id: [] });
    const res = await GET(req({ integracaoId: 'int-1', nome: 'xyz' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ recomendacoes: [], unresolved: 0, applied: false });
    expect(h.getCategory).not.toHaveBeenCalled();
  });

  it('deixa um erro alheio subir (regra 6)', async () => {
    h.categoryRecommend.mockRejectedValue(new TypeError('bug nosso'));
    await expect(
      GET(req({ integracaoId: 'int-1', nome: 'camiseta' }, AUTORIZADO)),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

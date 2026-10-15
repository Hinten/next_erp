import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ShopeeNetworkError } from '@delfrance/integrations-shopee';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { __setShopeeTaxonomiaClockForTests } from '@/lib/shopee/taxonomia/cache';
import { categoriaNoDtoSchema, categoriaResumoDtoSchema } from '@/lib/shopee/taxonomia/dto';

/**
 * Mocked: admin auth (drives `verifyCaller`) and the Shopee context loader
 * (Firestore + the token store). The taxonomy CACHES stay real — they are the
 * module under test as much as the route is — so both hooks reset them.
 *
 * ⚠️ `createShopClient` awaits `getAccessToken` INSIDE the call, exactly as
 * `createShopeeClient` does it, so a renewal failure surfaces where a real one
 * would.
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

const corpoSchema = z.object({
  raizes: z.array(categoriaResumoDtoSchema).nullable(),
  no: categoriaNoDtoSchema.nullable(),
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

/**
 * 100000 (raiz, com filhos) → 100100 (com filhos) → 100182 (folha)
 * 100200 (folha, filha de 100000) · 200000 (raiz, folha)
 */
const ARVORE = [
  categoria(100000, 0, true),
  categoria(100100, 100000, true),
  categoria(100182, 100100, false),
  categoria(100200, 100000, false),
  categoria(200000, 0, false),
];

function req(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/taxonomia/categorias');
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

describe('GET taxonomia/categorias — autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: 'int-1' }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await GET(req({ integracaoId: 'int-1' }, AUTORIZADO))).status).toBe(403);
  });

  it('responde 400 sem integracaoId', async () => {
    const res = await GET(req({}, AUTORIZADO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'integracaoId é obrigatório.' });
    expect(h.getCategory).not.toHaveBeenCalled();
  });

  it.each([
    ['com letras', '100182abc'],
    ['em notação científica', '1e5'],
    ['fracionário', '1.5'],
    ['com espaço à esquerda', ' 100182'],
  ])('responde 400 para um categoryId %s, sem chamar o provedor', async (_caso, valor) => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: valor }, AUTORIZADO));
    expect(res.status).toBe(400);
    expect(h.getCategory).not.toHaveBeenCalled();
  });

  it('responde 404 para uma conta de outro tipo', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    expect((await GET(req({ integracaoId: 'int-1' }, AUTORIZADO))).status).toBe(404);
  });
});

describe('a árvore inteira NUNCA atravessa este fio', () => {
  it('sem categoryId devolve só as RAÍZES', async () => {
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    // Cinco nós na árvore, duas raízes na resposta.
    expect(body.raizes).toHaveLength(2);
    expect(body).toHaveProperty('no', null);
    expect(JSON.stringify(body)).not.toContain('category_list');
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('com categoryId devolve UM nó, seu caminho e seus filhos diretos', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100100' }, AUTORIZADO));
    const body = (await res.json()) as { no: Record<string, unknown> | null };

    expect(res.status).toBe(200);
    expect(body.no).toMatchObject({ categoryId: 100100, parentId: 100000, isLeaf: false });
    expect(
      (body.no?.pathFromRoot as Array<{ categoryId: number }>).map((c) => c.categoryId),
    ).toEqual([100000, 100100]);
    expect((body.no?.children as Array<{ categoryId: number }>).map((c) => c.categoryId)).toEqual([
      100182,
    ]);
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('mantém parentId 0 na raiz — o zero é dado, não ausência', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '200000' }, AUTORIZADO));
    const body = (await res.json()) as { no: Record<string, unknown> };

    // Presença explícita: o schema acima passaria por cima de um campo ausente
    // se ele fosse opcional, e `0` é o valor que some sem ninguém notar.
    expect(body.no).toHaveProperty('parentId', 0);
    expect(body.no).toHaveProperty('isLeaf', true);
  });
});

describe('o veredicto de três valores', () => {
  it('um id fora da árvore é 404 SHOPEE_CATEGORIA_DESCONHECIDA, nunca 200 vazio', async () => {
    // Dobrar "desconhecida" em "não folha" responderia 200-com-nada para uma
    // categoria que não existe — indistinguível, na tela, de um nó do meio.
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '999999' }, AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_CATEGORIA_DESCONHECIDA' });
  });

  it('uma folha responde 200 com isLeaf true — o par do caso acima', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const body = (await res.json()) as { no: Record<string, unknown> };

    expect(res.status).toBe(200);
    expect(body.no).toMatchObject({ categoryId: 100182, isLeaf: true, children: [] });
  });
});

describe('o cache e os erros', () => {
  it('duas requisições da mesma conta fazem UMA leitura de get_category', async () => {
    await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(h.getCategory).toHaveBeenCalledTimes(1);
  });

  it('uma falha de rede vira 503 pelo mapeador comum', async () => {
    h.getCategory.mockRejectedValue(new ShopeeNetworkError('fetch falhou'));
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_NETWORK_ERROR' });
  });

  it('deixa um erro alheio subir em vez de engoli-lo (regra 6)', async () => {
    h.getCategory.mockRejectedValue(new TypeError('bug nosso'));
    await expect(GET(req({ integracaoId: 'int-1' }, AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
  });
});

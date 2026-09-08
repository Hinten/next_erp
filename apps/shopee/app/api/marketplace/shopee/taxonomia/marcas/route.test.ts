import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ShopeeNetworkError } from '@delfrance/integrations-shopee';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { __setShopeeTaxonomiaClockForTests } from '@/lib/shopee/taxonomia/cache';
import { marcaDtoSchema } from '@/lib/shopee/taxonomia/dto';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getAccessToken: vi.fn(),
  getCategory: vi.fn(),
  getBrandList: vi.fn(),
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
  leaf: z.boolean(),
  categoryId: z.number().int(),
  status: z.number().int(),
  offset: z.number().int(),
  pageSize: z.number().int(),
  marcas: z.array(marcaDtoSchema),
  hasNextPage: z.boolean(),
  nextOffset: z.number().int().nullable(),
  isMandatory: z.boolean().nullable(),
  inputType: z.string().nullable(),
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
  const url = new URL('http://localhost:3009/api/marketplace/shopee/taxonomia/marcas');
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
      async getBrandList(p: Record<string, unknown>) {
        await h.getAccessToken();
        return h.getBrandList(p);
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
  h.getBrandList.mockResolvedValue({
    brand_list: [
      { brand_id: 0, original_brand_name: 'No Brand', display_brand_name: null },
      { brand_id: 2500139861, original_brand_name: 'Hering', display_brand_name: 'Hering' },
    ],
    has_next_page: true,
    next_offset: 100,
    is_mandatory: false,
    input_type: 'TEXT_FILED',
  });
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  spyWarn.mockRestore();
  spyErro.mockRestore();
});

describe('GET taxonomia/marcas — autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: 'int-1', categoryId: '100182' }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(res.status).toBe(403);
  });

  it('responde 404 para uma conta de outro tipo', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(res.status).toBe(404);
  });

  it.each([
    ['sem integracaoId', {}, 'integracaoId é obrigatório.'],
    ['sem categoryId', { integracaoId: 'int-1' }, 'categoryId é obrigatório.'],
    [
      'com pageSize 0',
      { integracaoId: 'int-1', categoryId: '100182', pageSize: '0' },
      'pageSize deve estar entre 1 e 100.',
    ],
    [
      'com pageSize 101',
      { integracaoId: 'int-1', categoryId: '100182', pageSize: '101' },
      'pageSize deve estar entre 1 e 100.',
    ],
    [
      'com offset -1',
      { integracaoId: 'int-1', categoryId: '100182', offset: '-1' },
      'offset deve ser um inteiro >= 0.',
    ],
    [
      'com status 0',
      { integracaoId: 'int-1', categoryId: '100182', status: '0' },
      'status deve ser 1 (normal) ou 2 (pendente).',
    ],
    [
      'com status 3',
      { integracaoId: 'int-1', categoryId: '100182', status: '3' },
      'status deve ser 1 (normal) ou 2 (pendente).',
    ],
  ])('responde 400 %s, sem chamar o provedor', async (_caso, query, mensagem) => {
    const res = await GET(req(query, AUTORIZADO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: mensagem });
    expect(h.getBrandList).not.toHaveBeenCalled();
  });

  it.each([
    ['1 e 100 nas bordas do pageSize', { pageSize: '1' }, { pageSize: 1 }],
    ['100 na outra borda', { pageSize: '100' }, { pageSize: 100 }],
    ['offset 0 — o zero é a primeira página, não um valor ausente', { offset: '0' }, { offset: 0 }],
    ['status 2 (pendente)', { status: '2' }, { status: 2 }],
  ])('aceita %s', async (_caso, extra, esperado) => {
    await GET(req({ integracaoId: 'int-1', categoryId: '100182', ...extra }, AUTORIZADO));
    expect(h.getBrandList).toHaveBeenCalledWith(expect.objectContaining(esperado));
  });

  it('usa offset 0, pageSize 100 e status 1 quando nada é enviado', async () => {
    await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(h.getBrandList).toHaveBeenCalledWith({
      categoryId: 100182,
      offset: 0,
      pageSize: 100,
      status: 1,
    });
  });
});

describe('a trava de folha', () => {
  it('uma categoria do MEIO responde uma página vazia com ZERO chamadas', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100100' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ leaf: false, categoryId: 100100, marcas: [] });
    expect(body).toHaveProperty('nextOffset', null);
    expect(body).toHaveProperty('hasNextPage', false);
    expect(h.getBrandList).not.toHaveBeenCalled();
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('um id fora da árvore é 404', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '999999' }, AUTORIZADO));
    expect(res.status).toBe(404);
    expect(h.getBrandList).not.toHaveBeenCalled();
  });
});

describe('uma página de marcas', () => {
  it('entrega brand_id 0 e um id acima de int32', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const body = (await res.json()) as { marcas: Array<{ brandId: number }> };

    expect(body.marcas.map((m) => m.brandId)).toEqual([0, 2500139861]);
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('ecoa next_offset como veio e NÃO pagina sozinha', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toMatchObject({ hasNextPage: true, nextOffset: 100 });
    expect(h.getBrandList).toHaveBeenCalledTimes(1);
  });

  it('a segunda página é uma segunda REQUISIÇÃO, com o offset devolvido', async () => {
    await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    await GET(req({ integracaoId: 'int-1', categoryId: '100182', offset: '100' }, AUTORIZADO));

    expect(h.getBrandList).toHaveBeenCalledTimes(2);
    expect(h.getBrandList.mock.calls[1]?.[0]).toMatchObject({ offset: 100 });
  });

  it('a MESMA página vem do cache na segunda requisição', async () => {
    await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(h.getBrandList).toHaveBeenCalledTimes(1);
  });
});

describe('os erros', () => {
  it('uma falha de rede vira 503', async () => {
    h.getBrandList.mockRejectedValue(new ShopeeNetworkError('fetch falhou'));
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(res.status).toBe(503);
  });

  it('deixa um erro alheio subir (regra 6)', async () => {
    h.getBrandList.mockRejectedValue(new TypeError('bug nosso'));
    await expect(
      GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO)),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

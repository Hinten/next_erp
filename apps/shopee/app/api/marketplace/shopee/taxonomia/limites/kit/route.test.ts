import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { ShopeeNetworkError } from '@delfrance/integrations-shopee';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { __setShopeeTaxonomiaClockForTests } from '@/lib/shopee/taxonomia/cache';
import { limitesDeKitDtoSchema } from '@/lib/shopee/taxonomia/limites';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getAccessToken: vi.fn(),
  getCategory: vi.fn(),
  getItemLimit: vi.fn(),
  getKitItemLimit: vi.fn(),
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
  leaf: z.boolean().nullable(),
  scope: z.enum(['shop', 'category']),
  categoryId: z.number().int().nullable(),
  limites: limitesDeKitDtoSchema.nullable(),
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
  const url = new URL('http://localhost:3009/api/marketplace/shopee/taxonomia/limites/kit');
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
      async getItemLimit(p: Record<string, unknown>) {
        await h.getAccessToken();
        return h.getItemLimit(p);
      },
      async getKitItemLimit(p: Record<string, unknown>) {
        await h.getAccessToken();
        return h.getKitItemLimit(p);
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
  h.getItemLimit.mockResolvedValue({ response: {}, gtin_limit: null });
  h.getKitItemLimit.mockResolvedValue({
    price_limit: { min_limit: 2, max_limit: 5000, min: null, max: null },
    dts_limit: {
      non_pre_order_days_to_ship: 2,
      support_pre_order: false,
      days_to_ship_limit: { min_limit: 1, max_limit: 30, min: null, max: null },
    },
    component_count_limit_of_single_model: { min_limit: 2, max_limit: 10, min: null, max: null },
  });
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  spyWarn.mockRestore();
  spyErro.mockRestore();
});

describe('GET taxonomia/limites/kit — autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: 'int-1' }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await GET(req({ integracaoId: 'int-1' }, AUTORIZADO))).status).toBe(403);
  });

  it('responde 400 sem integracaoId', async () => {
    expect((await GET(req({}, AUTORIZADO))).status).toBe(400);
    expect(h.getKitItemLimit).not.toHaveBeenCalled();
  });

  it('responde 400 para um categoryId com letras', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182x' }, AUTORIZADO));
    expect(res.status).toBe(400);
    expect(h.getKitItemLimit).not.toHaveBeenCalled();
  });

  it('responde 404 para uma conta de outro tipo', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    expect((await GET(req({ integracaoId: 'int-1' }, AUTORIZADO))).status).toBe(404);
  });
});

describe('o kit tem os SEUS limites', () => {
  it('nunca chama get_item_limit', async () => {
    // Derivar as bandas do kit das do item publica um kit contra um teto que não
    // é o dele — as duas páginas discordam campo a campo.
    await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));

    expect(h.getKitItemLimit).toHaveBeenCalledTimes(1);
    expect(h.getItemLimit).not.toHaveBeenCalled();
  });

  it('entrega os campos que só a página do kit declara', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const body = (await res.json()) as { limites: Record<string, unknown> };

    expect(body.limites.componentCountLimitOfSingleModel).toEqual({ min: 2, max: 10 });
    // ⚠️ O boolean PRÓPRIO de Shopee, não o `supportsPreOrder` derivado do
    // sentinela na rota de item: a banda é positiva e o campo mesmo assim false.
    expect(body.limites.dtsLimit).toEqual({
      nonPreOrderDaysToShip: 2,
      supportPreOrder: false,
      daysToShipLimit: { min: 1, max: 30 },
    });
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });
});

describe('a trava de folha — aqui ela vale, ao contrário das bandas de item', () => {
  it('uma categoria do MEIO responde limites null com ZERO chamadas', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100100' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ leaf: false, scope: 'category', categoryId: 100100 });
    expect(body).toHaveProperty('limites', null);
    expect(h.getKitItemLimit).not.toHaveBeenCalled();
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('um id fora da árvore é 404', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '999999' }, AUTORIZADO));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_CATEGORIA_DESCONHECIDA' });
    expect(h.getKitItemLimit).not.toHaveBeenCalled();
  });

  it('sem categoryId a resposta é da loja e leaf é null, não false', async () => {
    // Não havia nada sobre o que perguntar: `false` seria uma afirmação que esta
    // requisição não fez.
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('leaf', null);
    expect(body).toMatchObject({ scope: 'shop', categoryId: null });
    expect(h.getKitItemLimit).toHaveBeenCalledWith({});
    expect(h.getCategory).not.toHaveBeenCalled();
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });
});

describe('os erros', () => {
  it('uma falha de rede vira 503, nunca limites nulos', async () => {
    h.getKitItemLimit.mockRejectedValue(new ShopeeNetworkError('fetch falhou'));
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_NETWORK_ERROR' });
  });

  it('deixa um erro alheio subir (regra 6)', async () => {
    h.getKitItemLimit.mockRejectedValue(new TypeError('bug nosso'));
    await expect(GET(req({ integracaoId: 'int-1' }, AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
  });
});

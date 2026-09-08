import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_GET_VARIATIONS_PATH,
  SHOPEE_GET_VARIATION_TREE_PATH_ALT,
  ShopeeNetworkError,
} from '@delfrance/integrations-shopee';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { __setShopeeTaxonomiaClockForTests } from '@/lib/shopee/taxonomia/cache';
import { variacaoDtoSchema } from '@/lib/shopee/taxonomia/dto';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getAccessToken: vi.fn(),
  getCategory: vi.fn(),
  getVariations: vi.fn(),
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
  standardiseVariationList: z.array(variacaoDtoSchema),
  pathUsed: z.string(),
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
  const url = new URL('http://localhost:3009/api/marketplace/shopee/taxonomia/variacoes');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers });
}

function ctxDouble(variationsPath: string | null = null) {
  return {
    integracaoId: 'int-1',
    conta: { tipo: 5, shop_id: 987654, main_account_id: null },
    config: {
      partnerId: 1000001,
      partnerKey: 'chave-de-teste-nao-e-credencial',
      variationsPath,
    },
    readCredential: vi.fn(),
    getAccessToken: h.getAccessToken,
    createShopClient: () => ({
      async getCategory() {
        await h.getAccessToken();
        return h.getCategory();
      },
      async getVariations(p: Record<string, unknown>) {
        await h.getAccessToken();
        return h.getVariations(p);
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
  h.getVariations.mockResolvedValue({
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
            ],
          },
        ],
      },
    ],
  });
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  spyWarn.mockRestore();
  spyErro.mockRestore();
});

describe('GET taxonomia/variacoes — autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: 'int-1', categoryId: '100182' }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(res.status).toBe(403);
  });

  it('responde 400 sem integracaoId', async () => {
    expect((await GET(req({ categoryId: '100182' }, AUTORIZADO))).status).toBe(400);
  });

  it('responde 400 sem categoryId', async () => {
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'categoryId é obrigatório.' });
    expect(h.getVariations).not.toHaveBeenCalled();
  });

  it('responde 404 para uma conta de outro tipo', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(res.status).toBe(404);
  });
});

describe('pathUsed instrumenta a contradição da página', () => {
  it('ecoa o caminho dos SAMPLES quando SHOPEE_VARIATIONS_PATH não está setada', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('pathUsed', SHOPEE_GET_VARIATIONS_PATH);
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('ecoa a sobrescrita quando ela existe — o par do caso acima', async () => {
    // O caminho vai DENTRO da base string do HMAC: o errado volta como
    // `error_sign`, que se parece com chave de parceiro errada. Ecoar o que foi
    // assinado é o que transforma uma chamada no sandbox em resposta.
    h.loadCtx.mockResolvedValue(ctxDouble(SHOPEE_GET_VARIATION_TREE_PATH_ALT));
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));

    await expect(res.json()).resolves.toMatchObject({
      pathUsed: SHOPEE_GET_VARIATION_TREE_PATH_ALT,
    });
  });

  it('também acompanha a resposta vazia de uma categoria do meio', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100100' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('pathUsed', SHOPEE_GET_VARIATIONS_PATH);
  });
});

describe('a trava de folha e o corpo', () => {
  it('uma categoria do MEIO responde lista vazia com ZERO chamadas', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100100' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ leaf: false, categoryId: 100100, standardiseVariationList: [] });
    expect(h.getVariations).not.toHaveBeenCalled();
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('um id fora da árvore é 404', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '999999' }, AUTORIZADO));
    expect(res.status).toBe(404);
    expect(h.getVariations).not.toHaveBeenCalled();
  });

  it('uma folha entrega a árvore e mantém variationOptionId 0', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const body = (await res.json()) as {
      standardiseVariationList: Array<{
        variationGroupList: Array<{ variationOptionList: Array<{ variationOptionId: number }> }>;
      }>;
    };

    expect(body.standardiseVariationList[0]?.variationGroupList[0]?.variationOptionList[0]).toEqual(
      { variationOptionId: 0, variationOptionName: 'Personalizado' },
    );
    expect(h.getVariations).toHaveBeenCalledWith({ categoryId: 100182 });
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });
});

describe('os erros', () => {
  it('uma falha de rede vira 503', async () => {
    h.getVariations.mockRejectedValue(new ShopeeNetworkError('fetch falhou'));
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(res.status).toBe(503);
  });

  it('deixa um erro alheio subir (regra 6)', async () => {
    h.getVariations.mockRejectedValue(new TypeError('bug nosso'));
    await expect(
      GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO)),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeNetworkError,
} from '@delfrance/integrations-shopee';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { __setShopeeTaxonomiaClockForTests } from '@/lib/shopee/taxonomia/cache';
import { limitesDeItemDtoSchema } from '@/lib/shopee/taxonomia/limites';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getAccessToken: vi.fn(),
  getCategory: vi.fn(),
  getItemLimit: vi.fn(),
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

function banda(min_limit: number | null, max_limit: number | null) {
  return { min_limit, max_limit, min: null, max: null };
}

function req(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/taxonomia/limites');
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
  h.getCategory.mockResolvedValue({ category_list: [] });
  h.getItemLimit.mockResolvedValue({
    response: {
      price_limit: banda(1.5, 9999.99),
      stock_limit: banda(0, 999),
      dts_limit: { days_to_ship_limit: banda(1, 30), non_pre_order_days_to_ship: 2 },
      size_chart_limit: {
        size_chart_mandatory: false,
        support_image_size_chart: true,
        support_template_size_chart: true,
      },
    },
    gtin_limit: null,
  });
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  spyWarn.mockRestore();
  spyErro.mockRestore();
});

describe('GET taxonomia/limites — autenticação e argumentos', () => {
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
    expect(h.getItemLimit).not.toHaveBeenCalled();
  });

  it('responde 400 para um categoryId inválido', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '0' }, AUTORIZADO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: 'categoryId deve ser um inteiro positivo.',
    });
    expect(h.getItemLimit).not.toHaveBeenCalled();
  });

  it('responde 404 para uma conta de outro tipo', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    expect((await GET(req({ integracaoId: 'int-1' }, AUTORIZADO))).status).toBe(404);
  });
});

describe('esta rota NÃO tem trava de folha', () => {
  it('sem categoryId responde o escopo da loja e nunca lê a árvore', async () => {
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ scope: 'shop' });
    // Presença explícita: `null` aqui é a leitura da loja inteira, não um campo
    // que a rota esqueceu de mandar.
    expect(body).toHaveProperty('categoryId', null);
    expect(h.getItemLimit).toHaveBeenCalledWith({});
    expect(h.getCategory).not.toHaveBeenCalled();
  });

  it('com uma categoria do MEIO da árvore ainda lê as bandas', async () => {
    // O parâmetro é documentado como opcional e a leitura por categoria é
    // documentada: travar por folha aqui negaria uma resposta que Shopee dá.
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100100' }, AUTORIZADO));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ scope: 'category', categoryId: 100100 });
    expect(h.getItemLimit).toHaveBeenCalledWith({ categoryId: 100100 });
    expect(h.getCategory).not.toHaveBeenCalled();
  });
});

describe('as bandas no corpo', () => {
  it('projeta as chaves camelCase e passa no contrato', async () => {
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    const {
      scope: _scope,
      categoryId: _categoryId,
      gtinLimit: _gtin,
      supportsPreOrder: _pre,
      ...limites
    } = (await res.json()) as Record<string, unknown>;

    expect(limites.priceLimit).toEqual({ min: 1.5, max: 9999.99 });
    expect(limites.stockLimit).toEqual({ min: 0, max: 999 });
    expect(() => limitesDeItemDtoSchema.parse(limites)).not.toThrow();
  });

  it.each([
    ['só DENTRO de response', { dentro: 'MANDATORY', irmao: null }, 'MANDATORY'],
    ['só como IRMÃO de response', { dentro: null, irmao: 'OPTIONAL' }, 'OPTIONAL'],
    ['nas duas, com a de dentro ganhando', { dentro: 'MANDATORY', irmao: 'OPTIONAL' }, 'MANDATORY'],
    ['em nenhuma das duas', { dentro: null, irmao: null }, null],
  ])('entrega gtinLimit quando ele vem %s', async (_caso, posicoes, esperado) => {
    h.getItemLimit.mockResolvedValue({
      response: {
        gtin_limit: posicoes.dentro === null ? null : { gtin_validation_rule: posicoes.dentro },
      },
      gtin_limit: posicoes.irmao === null ? null : { gtin_validation_rule: posicoes.irmao },
    });
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.gtinLimit).toEqual(esperado === null ? null : { gtinValidationRule: esperado });
  });

  it('supportsPreOrder é true para uma janela de verdade', async () => {
    const body = (await (await GET(req({ integracaoId: 'int-1' }, AUTORIZADO))).json()) as Record<
      string,
      unknown
    >;
    expect(body).toHaveProperty('supportsPreOrder', true);
  });

  it('-1 vira supportsPreOrder false e a banda CRUA continua no corpo', async () => {
    h.getItemLimit.mockResolvedValue({
      response: {
        dts_limit: { days_to_ship_limit: banda(1, -1), non_pre_order_days_to_ship: 2 },
      },
      gtin_limit: null,
    });
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('supportsPreOrder', false);
    expect(body.dtsLimit).toEqual({
      daysToShipLimit: { min: 1, max: -1 },
      nonPreOrderDaysToShip: 2,
    });
  });
});

describe('uma falha SOBE — nunca limites nulos', () => {
  it('uma falha de rede vira 503 e o corpo não traz bandas', async () => {
    // Se esta rota degradasse para `limites: null`, o passo 11 publicaria com
    // números chutados — e todo número da página de Shopee é um SAMPLE.
    h.getItemLimit.mockRejectedValue(new ShopeeNetworkError('fetch falhou'));
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(503);
    expect(body).toMatchObject({ code: 'SHOPEE_NETWORK_ERROR' });
    expect(body).not.toHaveProperty('priceLimit');
    expect(body).not.toHaveProperty('limites');
  });

  it('um envelope de erro da Shopee vira 502, e as bandas não vêm no corpo', async () => {
    h.getItemLimit.mockRejectedValue(
      new ShopeeApiError('Shopee respondeu error_param', {
        code: 'product.error_param',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: '/api/v2/product/get_item_limit',
      }),
    );
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(502);
    expect(body).toMatchObject({ code: 'SHOPEE_HTTP_ERROR' });
    expect(body).not.toHaveProperty('priceLimit');
    expect(body).not.toHaveProperty('supportsPreOrder');
  });

  it('deixa um erro alheio subir (regra 6)', async () => {
    h.getItemLimit.mockRejectedValue(new TypeError('bug nosso'));
    await expect(GET(req({ integracaoId: 'int-1' }, AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
  });
});

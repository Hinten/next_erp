import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PERM } from '@delfrance/auth';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_SURFACE,
  ShopeeNetworkError,
  ShopeeOperacaoNaoServidaError,
  createShopeeClient,
  resolveShopeeHosts,
  shopeeErrorFromEnvelope,
} from '@delfrance/integrations-shopee';

import { lerFixture } from '@/lib/shopee/fixtures/wireCorpus';
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

const corpoSchema = z
  .object({
    leaf: z.boolean().nullable(),
    scope: z.enum(['shop', 'category']),
    categoryId: z.number().int().nullable(),
    // `null` only on the non-leaf short-circuit — the kit read was never made.
    indisponivel: z.boolean().nullable(),
    limites: limitesDeKitDtoSchema.nullable(),
  })
  .strict();

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

    expect(body).toHaveProperty('indisponivel', false);
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
  it('uma categoria do MEIO responde limites null com ZERO chamadas a get_kit_item_limit', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100100' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ leaf: false, scope: 'category', categoryId: 100100 });
    expect(body).toHaveProperty('limites', null);
    // `null`, not `false`: nothing was asked, so nothing is claimed about the host.
    expect(body).toHaveProperty('indisponivel', null);
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

describe('o host que NÃO serve get_kit_item_limit (passo 19) — 200 com `indisponivel`', () => {
  /** The package's own envelope builder, so the class is the one production sees. */
  function doEnvelope(
    corpo: { error: string; message: string | null; request_id: string | null },
    httpStatus: number,
  ) {
    return shopeeErrorFromEnvelope(
      { ...corpo, warning: null },
      { path: SHOPEE_GET_KIT_ITEM_LIMIT_PATH, httpStatus, surface: SHOPEE_SURFACE.business },
    );
  }

  it('M72 — o 404 do gateway responde 200 `{ leaf, indisponivel: true, limites: null }`, nunca 502', async () => {
    const gateway = doEnvelope({ error: 'error_not_found', message: null, request_id: null }, 404);
    expect(gateway).toBeInstanceOf(ShopeeOperacaoNaoServidaError);
    h.getKitItemLimit.mockRejectedValue(gateway);

    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({
      leaf: true,
      scope: 'category',
      categoryId: 100182,
      indisponivel: true,
      limites: null,
    });
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('⛔ QUASE-PAR: o error_not_found de NEGÓCIO (mensagem + request_id) continua 502', async () => {
    h.getKitItemLimit.mockRejectedValue(
      doEnvelope({ error: 'error_not_found', message: 'not found', request_id: 'r-1' }, 404),
    );

    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: 'SHOPEE_HTTP_ERROR', shopeeCode: 'error_not_found' });
    expect(body).not.toHaveProperty('indisponivel');
  });
});

describe('IDA E VOLTA — o corpo COMMITADO do gateway pelo cliente REAL até a rota', () => {
  /**
   * `get_kit_item_limit.sg-http404.json` is the probe's bare body
   * (`{"error":"error_not_found"}`); the file carries no status, so the test
   * serves it with the 404 its name says. Only `fetch` is a double — the
   * signer, `shopeeCall`, the envelope builder, the cache and the route are real.
   */
  const FIXTURE_GATEWAY = 'get_kit_item_limit.sg-http404.json';

  function ctxComClienteReal(status: number) {
    const chamadas: string[] = [];
    const corpo = JSON.stringify(lerFixture(FIXTURE_GATEWAY));
    return {
      chamadas,
      ctx: {
        ...ctxDouble(),
        createShopClient: () =>
          createShopeeClient({
            partnerId: 1000001,
            partnerKey: 'chave-de-teste-nao-e-credencial',
            hosts: resolveShopeeHosts({ sandbox: true }),
            shopId: 987654,
            getAccessToken: () => Promise.resolve('access-inventado'),
            fetch: (entrada) => {
              const url =
                typeof entrada === 'string'
                  ? entrada
                  : entrada instanceof URL
                    ? entrada.href
                    : entrada.url;
              chamadas.push(new URL(url).pathname);
              return Promise.resolve(
                new Response(corpo, { status, headers: { 'content-type': 'application/json' } }),
              );
            },
          }),
      },
    };
  }

  it('o corpo em HTTP 404 ⇒ 200 `indisponivel: true`, e a segunda chamada sai do cache', async () => {
    const { chamadas, ctx } = ctxComClienteReal(404);
    h.loadCtx.mockResolvedValue(ctx);

    const primeira = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    const segunda = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));

    for (const res of [primeira, segunda]) {
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        leaf: null,
        scope: 'shop',
        categoryId: null,
        indisponivel: true,
        limites: null,
      });
    }
    expect(chamadas).toEqual([SHOPEE_GET_KIT_ITEM_LIMIT_PATH]);
  });

  it('⛔ QUASE-PAR: o MESMO corpo em HTTP 200 é uma falha comum ⇒ 502, e não fica no cache', async () => {
    const { chamadas, ctx } = ctxComClienteReal(200);
    h.loadCtx.mockResolvedValue(ctx);

    const primeira = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    const segunda = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));

    expect(primeira.status).toBe(502);
    expect(segunda.status).toBe(502);
    expect(chamadas).toHaveLength(2);
  });
});

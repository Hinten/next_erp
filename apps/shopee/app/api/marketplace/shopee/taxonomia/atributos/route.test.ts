import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { READ_CACHE_DISABLED_ENV, __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { SHOPEE_ERROR_KIND, ShopeeApiError } from '@delfrance/integrations-shopee';
import {
  atributoDtoSchema as atributoCompartilhado,
  respostaAtributosShopeeSchema,
} from '@delfrance/schemas';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { __setShopeeTaxonomiaClockForTests } from '@/lib/shopee/taxonomia/cache';
import { atributoDtoSchema } from '@/lib/shopee/taxonomia/dto';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  getAccessToken: vi.fn(),
  getCategory: vi.fn(),
  getAttributeTree: vi.fn(),
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

/**
 * The SHARED envelope (#1911 P2) — declared once in `@delfrance/schemas` for
 * this route and its browser readers — never a test-local twin. Bound to the old
 * local name so every case below is byte-unedited: P2 is behaviour-neutral, and
 * those cases staying green UNCHANGED is the proof.
 */
const corpoSchema = respostaAtributosShopeeSchema;

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

function atributo(attribute_id: number, mandatory = true) {
  return {
    attribute_id,
    mandatory,
    name: `atributo-${String(attribute_id)}`,
    attribute_value_list: [
      { value_id: 0, name: 'Custom', value_unit: null, child_attribute_list: [], multi_lang: [] },
    ],
    attribute_info: null,
    multi_lang: [],
  };
}

function req(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/taxonomia/atributos');
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
      async getAttributeTree(p: { categoryIds: readonly number[] }) {
        await h.getAccessToken();
        return h.getAttributeTree(p);
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
  h.getAttributeTree.mockResolvedValue({
    list: [{ category_id: 100182, warning: null, attribute_tree: [atributo(7)] }],
  });
});

afterEach(() => {
  __resetAllReadCaches();
  __setShopeeTaxonomiaClockForTests();
  vi.unstubAllEnvs();
  spyWarn.mockRestore();
  spyErro.mockRestore();
});

describe('GET taxonomia/atributos — autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: 'int-1', categoryId: '100182' }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(res.status).toBe(403);
  });

  it('responde 400 sem integracaoId', async () => {
    const res = await GET(req({ categoryId: '100182' }, AUTORIZADO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'integracaoId é obrigatório.' });
  });

  it('responde 400 sem categoryId — aqui ele NÃO é opcional', async () => {
    const res = await GET(req({ integracaoId: 'int-1' }, AUTORIZADO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'categoryId é obrigatório.' });
    expect(h.getCategory).not.toHaveBeenCalled();
  });

  it('responde 400 para um categoryId que não é só dígitos', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182abc' }, AUTORIZADO));
    expect(res.status).toBe(400);
    expect(h.getAttributeTree).not.toHaveBeenCalled();
  });

  it('responde 404 para uma conta de outro tipo', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    expect(res.status).toBe(404);
  });
});

describe('a trava de folha', () => {
  it('uma categoria do MEIO responde 200 vazio e ZERO chamadas a get_attribute_tree', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100100' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ leaf: false, categoryId: 100100, atributos: [] });
    expect(body).toHaveProperty('warning', null);
    expect(body).toHaveProperty('truncated', false);
    expect(h.getAttributeTree).not.toHaveBeenCalled();
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('um id fora da árvore é 404, não 200 vazio', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '999999' }, AUTORIZADO));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_CATEGORIA_DESCONHECIDA' });
    expect(h.getAttributeTree).not.toHaveBeenCalled();
  });

  it('uma folha lê os atributos — o par dos dois casos acima', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ leaf: true, categoryId: 100182 });
    // O `truncated` é declarado com default no schema, então a asserção de
    // PRESENÇA é o que impede o parse abaixo de passar por cima de um campo que
    // a rota tivesse esquecido de mandar.
    expect(body).toHaveProperty('truncated', false);
    expect(h.getAttributeTree).toHaveBeenCalledTimes(1);
    expect(h.getAttributeTree).toHaveBeenCalledWith({ categoryIds: [100182] });
    expect(() => corpoSchema.parse(body)).not.toThrow();
  });

  it('mantém value_id 0 no corpo da resposta', async () => {
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const body = (await res.json()) as {
      atributos: Array<{ attributeValueList: Array<{ valueId: number }> }>;
    };
    expect(body.atributos[0]?.attributeValueList[0]?.valueId).toBe(0);
  });
});

describe('o aviso por categoria', () => {
  it('warning "success" não vira campo nem linha de log', async () => {
    h.getAttributeTree.mockResolvedValue({
      list: [{ category_id: 100182, warning: 'success', attribute_tree: [] }],
    });
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const body = (await res.json()) as Record<string, unknown>;

    expect(body).toHaveProperty('warning', null);
    expect(spyWarn).not.toHaveBeenCalled();
  });

  it('um aviso de verdade chega ao corpo — o par do caso acima', async () => {
    h.getAttributeTree.mockResolvedValue({
      list: [{ category_id: 100182, warning: 'brand is mandatory', attribute_tree: [] }],
    });
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));

    await expect(res.json()).resolves.toMatchObject({ warning: 'brand is mandatory' });
  });
});

describe('os erros', () => {
  it('error_param vira 502 e deixa a linha CRUA no log', async () => {
    h.getAttributeTree.mockRejectedValue(
      new ShopeeApiError('Shopee respondeu product.error_param', {
        code: 'product.error_param',
        kind: SHOPEE_ERROR_KIND.other,
        httpStatus: 200,
        path: '/api/v2/product/get_attribute_tree',
      }),
    );
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ shopeeCode: 'product.error_param' });
    const linhas = spyWarn.mock.calls.map((c: unknown[]) => c[0]);
    expect(linhas).toContain('[shopee/taxonomia] get_attribute_tree recusou o parâmetro enviado');
  });

  it('deixa um erro alheio subir (regra 6)', async () => {
    h.getAttributeTree.mockRejectedValue(new TypeError('bug nosso'));
    await expect(
      GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO)),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('o contrato compartilhado com apps/web (#1911 P2)', () => {
  /**
   * Uma árvore com TODO nível preenchido: `attribute_info` inteiro, uma unidade,
   * e um valor que destrava um atributo filho. Um parse que só visse a raiz
   * deixaria uma chave renomeada lá embaixo passar.
   */
  function atributoProfundo() {
    return {
      ...atributo(9),
      attribute_info: {
        input_type: 1,
        input_validation_type: 2,
        format_type: 1,
        date_format_type: null,
        attribute_unit_list: ['cm'],
        max_value_count: 3,
        introduction: 'Material principal',
        is_oem: false,
        support_search_value: true,
      },
      attribute_value_list: [
        {
          value_id: 55,
          name: 'Algodão',
          value_unit: 'cm',
          child_attribute_list: [atributo(10, false)],
          multi_lang: [],
        },
      ],
    };
  }

  it('o atributo que este app re-exporta É o de @delfrance/schemas — nunca uma cópia', () => {
    expect(atributoDtoSchema).toBe(atributoCompartilhado);
  });

  it.each([
    ['uma folha com a árvore inteira', '100182'],
    ['uma categoria do meio', '100100'],
  ])(
    'o 200 de %s volta IGUAL do schema compartilhado — nenhuma chave descartada',
    async (_c, id) => {
      h.getAttributeTree.mockResolvedValue({
        list: [{ category_id: 100182, warning: null, attribute_tree: [atributoProfundo()] }],
      });
      const res = await GET(req({ integracaoId: 'int-1', categoryId: id }, AUTORIZADO));
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(respostaAtributosShopeeSchema.parse(body)).toEqual(body);
      expect(Object.keys(body).sort()).toEqual(
        Object.keys(respostaAtributosShopeeSchema.shape).sort(),
      );
    },
  );

  it('o parse acima não é vazio: ele chegou ao atributo FILHO e ao attribute_info', async () => {
    h.getAttributeTree.mockResolvedValue({
      list: [{ category_id: 100182, warning: null, attribute_tree: [atributoProfundo()] }],
    });
    const res = await GET(req({ integracaoId: 'int-1', categoryId: '100182' }, AUTORIZADO));
    const lido = respostaAtributosShopeeSchema.parse(await res.json());

    expect(lido.atributos[0]?.attributeInfo).toMatchObject({ maxValueCount: 3, isOem: false });
    expect(lido.atributos[0]?.attributeValueList[0]?.childAttributeList[0]).toMatchObject({
      attributeId: 10,
      mandatory: false,
    });
  });
});

import { describe, expect, it } from 'vitest';

import {
  SHOPEE_INVOICE_ISSUER,
  SHOPEE_SHOP_STATUS,
  dataOp,
  flatOp,
  shopeeAtributoSchema,
  shopeeAttributeTreeSchema,
  shopeeBrandListSchema,
  shopeeCategoriaSchema,
  shopeeCategoryListSchema,
  shopeeCategoryRecommendSchema,
  shopeeEnvelopeSchema,
  shopeeFaixaSchema,
  shopeeItemLimitSchema,
  shopeeKitItemLimitSchema,
  shopeeProfileSchema,
  shopeeShopInfoSchema,
  shopeeShopStatusSchema,
  shopeeShopsByPartnerSchema,
  shopeeTokenResponseSchema,
  shopeeVariationsSchema,
  wrappedOp,
} from '../src/types';
import { z } from 'zod';

const SHOP_INFO = {
  error: '',
  request_id: 'req-1',
  shop_name: 'Loja de teste',
  region: 'BR',
  status: 'NORMAL',
  is_cb: false,
  auth_time: 1655714431,
  expire_time: 1687250431,
};

describe('the envelope', () => {
  it('REFUSES a body with no `error` field', () => {
    // ⚠️ The single most load-bearing assertion in this file. `error === ''` is
    // the success signal, so defaulting it would read an unknown body as a
    // successful call.
    const parsed = shopeeEnvelopeSchema.safeParse({ request_id: 'x' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join('.'))).toContain('error');
  });

  it('defaults the other three to null and keeps unknown keys', () => {
    const parsed = shopeeEnvelopeSchema.parse({ error: '', campo_novo: 42 });
    expect(parsed.request_id).toBeNull();
    expect(parsed.message).toBeNull();
    expect(parsed.warning).toBeNull();
    expect((parsed as Record<string, unknown>).campo_novo).toBe(42);
  });

  it('treats `error: ""` and `error: " "` as DIFFERENT values', () => {
    // NEAR-MISS: both parse, and only one of them means success. The equality is
    // `api.ts`'s job; this pins that the schema does not trim them together.
    expect(shopeeEnvelopeSchema.parse({ error: '' }).error).toBe('');
    expect(shopeeEnvelopeSchema.parse({ error: ' ' }).error).toBe(' ');
    expect(shopeeEnvelopeSchema.parse({ error: '' }).error).not.toBe(
      shopeeEnvelopeSchema.parse({ error: ' ' }).error,
    );
  });
});

describe('flatOp / wrappedOp', () => {
  it('flatOp puts the operation fields beside the envelope', () => {
    const schema = flatOp({ campo: z.string() });
    const parsed = schema.parse({ error: '', campo: 'v' });
    expect(parsed.campo).toBe('v');
    expect(parsed.error).toBe('');
  });

  it('wrappedOp REQUIRES the response wrapper', () => {
    const schema = wrappedOp(z.object({ campo: z.string() }));
    expect(schema.safeParse({ error: '', campo: 'v' }).success).toBe(false);
    expect(schema.parse({ error: '', response: { campo: 'v' } }).response.campo).toBe('v');
  });
});

describe('the number fields tolerate a quoted number', () => {
  it('reads a stringified shop_id as a number', () => {
    const parsed = shopeeShopsByPartnerSchema.parse({
      error: '',
      more: false,
      authed_shop_list: [{ shop_id: '14701711', auth_time: '1655714431', expire_time: 1687250431 }],
    });
    expect(parsed.authed_shop_list[0]?.shop_id).toBe(14701711);
    expect(parsed.authed_shop_list[0]?.auth_time).toBe(1655714431);
    expect(parsed.authed_shop_list[0]?.region).toBeNull();
  });

  it('still REFUSES a value that is not unambiguously one number', () => {
    // NEAR-MISS to the one above: tolerance must not become coercion. `'0x1F'`
    // and `''` are the two shapes `z.coerce.number()` would silently invent a
    // value for (31 and 0).
    for (const bad of ['0x1F', '', '1 000', 'muitos']) {
      expect(
        shopeeShopsByPartnerSchema.safeParse({
          error: '',
          more: false,
          authed_shop_list: [{ shop_id: bad, auth_time: 1, expire_time: 2 }],
        }).success,
        `shop_id ${JSON.stringify(bad)} must not parse`,
      ).toBe(false);
    }
  });

  it('reads a quoted expire_in on the token response', () => {
    const parsed = shopeeTokenResponseSchema.parse({
      error: '',
      access_token: 'at',
      refresh_token: 'rt',
      expire_in: '14400',
    });
    expect(parsed.expire_in).toBe(14400);
    expect(parsed.shop_id_list).toBeNull();
    expect(parsed.merchant_id_list).toBeNull();
  });
});

describe('the enums', () => {
  it('rejects a lowercase status', () => {
    // NEAR-MISS: Shopee sends SHOUTING constants. A case-folded match would let a
    // typo'd value through as a real state.
    expect(shopeeShopStatusSchema.safeParse('NORMAL').success).toBe(true);
    expect(shopeeShopStatusSchema.safeParse('normal').success).toBe(false);
    expect(shopeeShopStatusSchema.safeParse('Normal').success).toBe(false);
  });

  it('keeps every companion member in step with the schema options', () => {
    expect([...Object.values(SHOPEE_SHOP_STATUS)].sort()).toEqual(
      [...shopeeShopStatusSchema.options].sort(),
    );
    expect([...Object.values(SHOPEE_INVOICE_ISSUER)].sort()).toEqual(['Other', 'Shopee']);
  });

  it('fails a shop-info body whose status is unknown', () => {
    expect(shopeeShopInfoSchema.safeParse({ ...SHOP_INFO, status: 'SUSPENDED' }).success).toBe(
      false,
    );
  });
});

describe('flat vs wrapped, per operation', () => {
  it('get_shop_info is FLAT', () => {
    const parsed = shopeeShopInfoSchema.parse(SHOP_INFO);
    expect(parsed.shop_name).toBe('Loja de teste');
    expect(parsed.status).toBe(SHOPEE_SHOP_STATUS.normal);
    expect(parsed.merchant_id).toBeNull();
  });

  it('get_profile is WRAPPED', () => {
    expect(
      shopeeProfileSchema.safeParse({ error: '', shop_name: 'Loja', description: null }).success,
    ).toBe(false);
    const parsed = shopeeProfileSchema.parse({
      error: '',
      response: { shop_name: 'Loja', invoice_issuer: 'Shopee' },
    });
    expect(parsed.response.shop_name).toBe('Loja');
    expect(parsed.response.invoice_issuer).toBe(SHOPEE_INVOICE_ISSUER.shopee);
    expect(parsed.response.shop_logo).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                        The taxonomy schemas (step 10)                       */
/* -------------------------------------------------------------------------- */

const CATEGORIA = {
  category_id: 100017,
  parent_category_id: 0,
  original_category_name: 'Moda Feminina',
  display_category_name: 'Moda Feminina',
  has_children: true,
};

describe('dataOp', () => {
  it('EXIGE o invólucro `data`', () => {
    const schema = dataOp(z.object({ campo: z.string() }));
    expect(schema.safeParse({ error: '', campo: 'v' }).success).toBe(false);
    expect(schema.parse({ error: '', data: { campo: 'v' } }).data.campo).toBe('v');
  });

  it('não é intercambiável com wrappedOp em NENHUMA das duas direções', () => {
    // NEAR-MISS ao par acima: os dois invólucros carregam o mesmo payload e só o
    // nome da chave difere, que é exatamente o erro que passaria despercebido se
    // um "modo" no cliente decidisse a forma em vez do schema da operação.
    const sobData = dataOp(z.object({ campo: z.string() }));
    const sobResponse = wrappedOp(z.object({ campo: z.string() }));
    expect(sobData.safeParse({ error: '', response: { campo: 'v' } }).success).toBe(false);
    expect(sobResponse.safeParse({ error: '', data: { campo: 'v' } }).success).toBe(false);
  });
});

describe('a faixa {min,max}', () => {
  it('aceita as DUAS grafias e devolve null na que não veio', () => {
    const comLimit = shopeeFaixaSchema.parse({ min_limit: 5.5, max_limit: 10000000.0 });
    expect(comLimit.min_limit).toBe(5.5);
    expect(comLimit.min).toBeNull();

    const semLimit = shopeeFaixaSchema.parse({ min: 1, max: 2 });
    expect(semLimit.min).toBe(1);
    expect(semLimit.max_limit).toBeNull();
  });
});

describe('get_category', () => {
  it('aceita `has_children: false` e RECUSA a string "false"', () => {
    // NEAR-MISS: a string é o único sinal de folha que a Shopee dá, e `"false"`
    // é VERDADEIRO em JS — uma coerção transformaria toda folha em não-folha (ou
    // inventaria uma folha), e as duas leituras silenciosas são piores do que a
    // falha barulhenta.
    expect(shopeeCategoriaSchema.parse({ ...CATEGORIA, has_children: false }).has_children).toBe(
      false,
    );
    expect(shopeeCategoriaSchema.safeParse({ ...CATEGORIA, has_children: 'false' }).success).toBe(
      false,
    );
    expect(shopeeCategoriaSchema.safeParse({ ...CATEGORIA, has_children: 0 }).success).toBe(false);
  });

  it('mantém `parent_category_id: 0` (raiz) e preserva campos desconhecidos', () => {
    const parsed = shopeeCategoriaSchema.parse({ ...CATEGORIA, campo_novo: 'x' });
    expect(parsed.parent_category_id).toBe(0);
    expect((parsed as Record<string, unknown>).campo_novo).toBe('x');
  });
});

describe('a árvore de atributos', () => {
  const TRES_NIVEIS = {
    error: '',
    response: {
      list: [
        {
          category_id: 100017,
          warning: 'atributos parciais',
          attribute_tree: [
            {
              attribute_id: 1,
              mandatory: true,
              name: 'Material',
              attribute_value_list: [
                {
                  value_id: 10,
                  name: 'Algodão',
                  child_attribute_list: [
                    {
                      attribute_id: 2,
                      mandatory: false,
                      name: 'Composição',
                      attribute_value_list: [{ value_id: 20, name: '100%' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };

  it('lê três níveis: atributo → valor → atributo filho → valor', () => {
    const parsed = shopeeAttributeTreeSchema.parse(TRES_NIVEIS);
    const raiz = parsed.response.list[0]?.attribute_tree[0];
    const filho = raiz?.attribute_value_list[0]?.child_attribute_list[0];
    expect(raiz?.name).toBe('Material');
    expect(filho?.attribute_id).toBe(2);
    expect(filho?.mandatory).toBe(false);
    expect(filho?.attribute_value_list[0]?.value_id).toBe(20);
    // As listas ausentes viram `[]`, nunca `undefined`.
    expect(filho?.attribute_value_list[0]?.child_attribute_list).toEqual([]);
  });

  it('guarda o `warning` de CADA categoria separado do `warning` do envelope', () => {
    const parsed = shopeeAttributeTreeSchema.parse(TRES_NIVEIS);
    expect(parsed.warning).toBeNull();
    expect(parsed.response.list[0]?.warning).toBe('atributos parciais');
  });

  it('mantém `input_type` como INTEIRO e recusa a grafia em texto', () => {
    // NEAR-MISS: `get_recommend_attribute` devolve `DROP_DOWN`/`DATE_TYPE` para a
    // mesma ideia. Compartilhar o schema faria um valor de um vocabulário chegar
    // mudo no outro.
    const ok = shopeeAtributoSchema.parse({
      attribute_id: 1,
      mandatory: true,
      attribute_info: { input_type: 3, input_validation_type: 2 },
    });
    expect(ok.attribute_info?.input_type).toBe(3);
    expect(
      shopeeAtributoSchema.safeParse({
        attribute_id: 1,
        mandatory: true,
        attribute_info: { input_type: 'FREE_TEXT_FILED' },
      }).success,
    ).toBe(false);
  });
});

describe('as marcas', () => {
  const pagina = (marca: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    error: '',
    response: {
      brand_list: [marca],
      has_next_page: false,
      ...extra,
    },
  });

  it('mantém `brand_id: 0` ("Sem marca") como um VALOR', () => {
    const parsed = shopeeBrandListSchema.parse(
      pagina({ brand_id: 0, original_brand_name: 'No Brand' }),
    );
    expect(parsed.response.brand_list[0]?.brand_id).toBe(0);
    expect(parsed.response.brand_list[0]?.display_brand_name).toBeNull();
  });

  it('lê um brand_id acima de int32 e um id entre aspas', () => {
    const parsed = shopeeBrandListSchema.parse(
      pagina({ brand_id: 2500139861, original_brand_name: 'Nike' }, { next_offset: '100' }),
    );
    expect(parsed.response.brand_list[0]?.brand_id).toBe(2500139861);
    expect(parsed.response.next_offset).toBe(100);
  });

  it('aceita AS DUAS grafias de `input_type` com que a página se contradiz', () => {
    for (const valor of ['DROP_DOWN', 'TEXT_FILED']) {
      const parsed = shopeeBrandListSchema.parse(
        pagina({ brand_id: 1, original_brand_name: 'Nike' }, { input_type: valor }),
      );
      expect(parsed.response.input_type).toBe(valor);
    }
  });
});

describe('os limites de item', () => {
  const GTIN = { gtin_validation_rule: 'Mandatory' };

  it.each([
    { caso: 'só dentro de response', dentro: GTIN, fora: undefined },
    { caso: 'só como irmão de response', dentro: undefined, fora: GTIN },
    { caso: 'nas duas posições', dentro: GTIN, fora: GTIN },
    { caso: 'em nenhuma das duas', dentro: undefined, fora: undefined },
  ])('lê `gtin_limit` $caso', ({ dentro, fora }) => {
    const parsed = shopeeItemLimitSchema.parse({
      error: '',
      response: dentro === undefined ? {} : { gtin_limit: dentro },
      ...(fora === undefined ? {} : { gtin_limit: fora }),
    });
    expect(parsed.response.gtin_limit?.gtin_validation_rule ?? null).toBe(
      dentro === undefined ? null : 'Mandatory',
    );
    expect(parsed.gtin_limit?.gtin_validation_rule ?? null).toBe(
      fora === undefined ? null : 'Mandatory',
    );
  });

  it('aceita `-1` em days_to_ship_limit e o MANTÉM distinto de 0', () => {
    // `-1` significa "esta categoria não tem pré-venda" (guia 209 §4). Um
    // `.nonnegative()` recusaria um valor documentado, e ler `-1` como ausência
    // faria a faixa virar null — o que a leitora entenderia como "sem dado".
    const parsed = shopeeItemLimitSchema.parse({
      error: '',
      response: {
        dts_limit: {
          days_to_ship_limit: { min_limit: -1, max_limit: -1 },
          non_pre_order_days_to_ship: 2,
        },
      },
    });
    expect(parsed.response.dts_limit?.days_to_ship_limit?.min_limit).toBe(-1);
    expect(parsed.response.dts_limit?.days_to_ship_limit?.min_limit).not.toBe(0);
    expect(parsed.response.dts_limit?.non_pre_order_days_to_ship).toBe(2);
  });

  it('não confunde a forma do KIT com a do item', () => {
    // O corpo é o do kit; lido pelo schema de item, TODA banda que a página do
    // kit escreve com outro nome vira null — a prova de que as duas formas não
    // são a mesma e de que reaproveitar uma pela outra devolveria silêncio.
    const CORPO_KIT = {
      error: '',
      response: {
        description_limit: { description_length_min: 10, description_length_max: 499 },
        dts_limit: { non_pre_order_days_to_ship: 2, support_pre_order: true },
        component_count_limit_of_single_model: { min_limit: 2, max_limit: 10 },
      },
    };
    const comoKit = shopeeKitItemLimitSchema.parse(CORPO_KIT);
    expect(comoKit.response.description_limit?.description_length_max).toBe(499);
    expect(comoKit.response.dts_limit?.support_pre_order).toBe(true);
    expect(comoKit.response.component_count_limit_of_single_model?.max_limit).toBe(10);

    const comoItem = shopeeItemLimitSchema.parse(CORPO_KIT);
    expect(comoItem.response.extended_description_limit).toBeNull();
    expect(comoItem.response.size_chart_limit).toBeNull();
  });
});

describe('as variações', () => {
  const comId = (id: unknown) => ({
    error: '',
    data: {
      standardise_variation_list: [
        {
          variation_id: id,
          variation_name: 'Cor',
          variation_group_list: [
            {
              variation_group_id: 1,
              variation_option_list: [{ variation_option_id: 0, variation_option_name: 'Custom' }],
            },
          ],
        },
      ],
    },
  });

  it('lê um id de 15 dígitos entre aspas', () => {
    const parsed = shopeeVariationsSchema.parse(comId('123456789012345'));
    expect(parsed.data.standardise_variation_list[0]?.variation_id).toBe(123456789012345);
  });

  it('RECUSA um id que já não cabe num inteiro seguro', () => {
    // NEAR-MISS ao teste acima: tolerar aspas não pode virar arredondar. Este
    // valor está 2 acima de MAX_SAFE_INTEGER e `Number()` o arredonda em silêncio.
    expect(shopeeVariationsSchema.safeParse(comId('9007199254740993')).success).toBe(false);
    expect(shopeeVariationsSchema.safeParse(comId('0x1F')).success).toBe(false);
  });

  it('mantém `variation_option_id: 0` (opção personalizada)', () => {
    const parsed = shopeeVariationsSchema.parse(comId(1));
    const grupo = parsed.data.standardise_variation_list[0]?.variation_group_list[0];
    expect(grupo?.variation_option_list[0]?.variation_option_id).toBe(0);
    expect(grupo?.variation_group_name).toBeNull();
  });
});

describe('o invólucro de cada operação de taxonomia', () => {
  const OPS = [
    {
      nome: 'get_category',
      schema: shopeeCategoryListSchema,
      chave: 'response',
      payload: { category_list: [] },
    },
    {
      nome: 'get_attribute_tree',
      schema: shopeeAttributeTreeSchema,
      chave: 'response',
      payload: { list: [] },
    },
    {
      nome: 'get_brand_list',
      schema: shopeeBrandListSchema,
      chave: 'response',
      payload: { brand_list: [], has_next_page: false },
    },
    {
      nome: 'get_kit_item_limit',
      schema: shopeeKitItemLimitSchema,
      chave: 'response',
      payload: {},
    },
    {
      nome: 'category_recommend',
      schema: shopeeCategoryRecommendSchema,
      chave: 'response',
      payload: { category_id: [1, 2] },
    },
    {
      nome: 'get_variations',
      schema: shopeeVariationsSchema,
      chave: 'data',
      payload: { standardise_variation_list: [] },
    },
  ] as const;

  it.each(OPS)(
    '$nome vem sob `$chave` e recusa o outro invólucro',
    ({ schema, chave, payload }) => {
      const outra = chave === 'response' ? 'data' : 'response';
      expect(schema.safeParse({ error: '', [chave]: payload }).success).toBe(true);
      expect(schema.safeParse({ error: '', [outra]: payload }).success).toBe(false);
    },
  );

  it('get_item_limit não é nenhum dos três: `response` MAIS um irmão', () => {
    expect(shopeeItemLimitSchema.safeParse({ error: '', data: {} }).success).toBe(false);
    const parsed = shopeeItemLimitSchema.parse({ error: '', response: {}, campo_novo: 1 });
    expect(parsed.gtin_limit).toBeNull();
    expect((parsed as Record<string, unknown>).campo_novo).toBe(1);
  });
});

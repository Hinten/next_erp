import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  SHOPEE_INVOICE_ISSUER,
  SHOPEE_LOGISTICS_STATUS,
  SHOPEE_NESTING_AMBIGUOUS_KEYS,
  SHOPEE_PACKAGE_FULFILLMENT_STATUS,
  SHOPEE_SHOP_STATUS,
  SHOPEE_TRACKING_LOGISTICS_STATUS,
  type ShopeeNestingAmbiguousKey,
  dataOp,
  flatOp,
  shopeeAppPushConfigSchema,
  shopeeAtributoSchema,
  shopeeAttributeTreeSchema,
  shopeeBrandListSchema,
  shopeeCategoriaSchema,
  shopeeCategoryListSchema,
  shopeeCategoryRecommendSchema,
  shopeeConfirmLostPushSchema,
  shopeeEnvelopeSchema,
  shopeeEscrowDetailSchema,
  shopeeEscrowListSchema,
  shopeeFaixaSchema,
  shopeeItemBaseInfoSchema,
  shopeeItemLimitSchema,
  shopeeItemListSchema,
  shopeeKitItemInfoSchema,
  shopeeKitItemLimitSchema,
  shopeeLostPushSchema,
  shopeeModelListSchema,
  shopeeOrderDetailSchema,
  shopeeOrderListSchema,
  shopeePackageDetailItemSchema,
  shopeePackageDetailRowSchema,
  shopeePackageDetailSchema,
  shopeePackageItemSchema,
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

/* -------------------------------------------------------------------------- */
/*                     As páginas de push perdido (passo 4)                    */
/* -------------------------------------------------------------------------- */

const ENTRADA_PERDIDA = {
  shop_id: 727720655,
  code: 3,
  timestamp: 1660123127,
  data: '{"data":{"items":[],"ordersn":"220810QSK8S7BX","status":"PROCESSED","completed_scenario":"","update_time":1660123127},"shop_id":727720655,"code":3,"timestamp":1660123127}',
};

describe('a fila de mensagens perdidas', () => {
  it('push_message_list ausente ou null vira null — a fila vazia é o caso comum', () => {
    // ⚠️ Uma fila vazia é o estado SAUDÁVEL e nenhum exemplo mostra o que a
    // Shopee manda para ela. Um array obrigatório transformaria a saúde numa
    // falha de schema a cada duas horas.
    const ausente = shopeeLostPushSchema.parse({
      error: '',
      response: { has_next_page: false, last_message_id: 176610 },
    });
    expect(ausente.response.push_message_list).toBeNull();

    const nula = shopeeLostPushSchema.parse({
      error: '',
      response: { push_message_list: null, has_next_page: false, last_message_id: 176610 },
    });
    expect(nula.response.push_message_list).toBeNull();
  });

  it('lê shop_id, code, timestamp e last_message_id em STRING', () => {
    const parsed = shopeeLostPushSchema.parse({
      error: '',
      response: {
        push_message_list: [
          { ...ENTRADA_PERDIDA, shop_id: '727720655', code: '3', timestamp: '1660123127' },
        ],
        has_next_page: false,
        last_message_id: '176610',
      },
    });
    const entrada = parsed.response.push_message_list?.[0];
    expect(entrada?.shop_id).toBe(727720655);
    expect(entrada?.code).toBe(3);
    expect(entrada?.timestamp).toBe(1660123127);
    expect(parsed.response.last_message_id).toBe(176610);
  });

  it('uma entrada sem shop_id parseia — o push de nível de parceiro não traz loja', () => {
    // A própria página: "If it's a partner level push (such as code: 1, 2, 12),
    // shop_id will not be returned." O "such as" é o que impede derivar
    // nível-de-parceiro a partir do código.
    const parsed = shopeeLostPushSchema.parse({
      error: '',
      response: {
        push_message_list: [{ code: 12, timestamp: 1660123127, data: '{}' }],
        has_next_page: false,
        last_message_id: 1,
      },
    });
    expect(parsed.response.push_message_list?.[0]?.shop_id).toBeNull();
    expect(parsed.response.push_message_list?.[0]?.code).toBe(12);
  });

  it('`data` continua uma STRING — o pacote nunca faz JSON.parse dela', () => {
    // ⚠️ Ler a string aqui seria decidir, dentro do pacote, o que fazer quando
    // ela não é legível — e essa decisão precisa virar uma linha durável, que
    // este pacote não tem onde escrever.
    const parsed = shopeeLostPushSchema.parse({
      error: '',
      response: {
        push_message_list: [ENTRADA_PERDIDA],
        has_next_page: true,
        last_message_id: 176610,
      },
    });
    const bruto = parsed.response.push_message_list?.[0]?.data;
    expect(typeof bruto).toBe('string');
    expect(bruto).toBe(ENTRADA_PERDIDA.data);
    expect(parsed.response.has_next_page).toBe(true);
  });

  it('UMA entrada malformada não derruba a página — as outras 99 continuam legíveis', () => {
    // ⚠️ Um array Zod falha INTEIRO (#1488) e esta fila pagina por
    // CONFIRMAÇÃO: com um elemento estrito, uma entrada ruim rejeitaria a
    // página toda e esconderia tudo que está atrás dela por três dias.
    const parsed = shopeeLostPushSchema.parse({
      error: '',
      response: {
        push_message_list: [
          ENTRADA_PERDIDA,
          { shop_id: 727720655, code: 3, data: '{"code":3}' }, // sem timestamp
          { shop_id: 727720655, timestamp: 1660123127, data: '{"code":3}' }, // sem code
          { shop_id: 727720655, code: 3, timestamp: 1660123127 }, // sem data
          ENTRADA_PERDIDA,
        ],
        has_next_page: false,
        last_message_id: 176610,
      },
    });
    const lista = parsed.response.push_message_list ?? [];
    expect(lista).toHaveLength(5);
    expect(lista[0]?.data).toBe(ENTRADA_PERDIDA.data);
    expect(lista[4]?.data).toBe(ENTRADA_PERDIDA.data);
    expect(lista[1]?.timestamp).toBeNull();
    expect(lista[2]?.code).toBeNull();
    // `data` ausente vira o texto JSON de `undefined`, que o leitor do app
    // parseia como `null` e para numa linha terminal — nunca um silêncio.
    expect(lista[3]?.data).toBe('null');
  });

  it('a tolerância NÃO engole um valor real — a coerção do wire vem antes dela', () => {
    // NEAR-MISS do teste acima: `'0'` e `'-3'` são valores LEGÍTIMOS que
    // `wireInt()` coage; se o `.catch` estivesse no lugar do parse, os dois
    // voltariam como null e a entrada perderia o código que a identifica.
    const parsed = shopeeLostPushSchema.parse({
      error: '',
      response: {
        push_message_list: [{ ...ENTRADA_PERDIDA, code: '0', timestamp: '-3' }],
        has_next_page: false,
        last_message_id: 1,
      },
    });
    expect(parsed.response.push_message_list?.[0]?.code).toBe(0);
    expect(parsed.response.push_message_list?.[0]?.timestamp).toBe(-3);
  });

  it('`data` que chega como OBJETO é preservada em texto, nunca descartada', () => {
    // A forma "envelope inteiro numa string" é evidenciada só pelo exemplo. Se
    // a página um dia responder o objeto, o app recebe os MESMOS bytes que
    // teria parseado — e a leitura segue normal, sem linha parada.
    const envelope = { data: { ordersn: 'SN1' }, shop_id: 727720655, code: 3, timestamp: 1 };
    const parsed = shopeeLostPushSchema.parse({
      error: '',
      response: {
        push_message_list: [{ shop_id: 727720655, code: 3, timestamp: 1, data: envelope }],
        has_next_page: false,
        last_message_id: 1,
      },
    });
    const bruto = parsed.response.push_message_list?.[0]?.data;
    expect(typeof bruto).toBe('string');
    expect(JSON.parse(String(bruto))).toEqual(envelope);
  });

  it('has_next_page é um boolean ESTRITO — a string "false" falha', () => {
    // NEAR-MISS: uma string coagida é truthy, e este é o sinal que diz se
    // sobraram mensagens atrás das 100 desta página.
    expect(
      shopeeLostPushSchema.safeParse({
        error: '',
        response: { push_message_list: [], has_next_page: 'false', last_message_id: 1 },
      }).success,
    ).toBe(false);
  });

  it('a resposta do confirm é o envelope NU — não existe objeto response', () => {
    const parsed = shopeeConfirmLostPushSchema.parse({
      error: '',
      message: '',
      warning: '',
      request_id: '668ea92da2a19f7d2e72bf98bd530c41',
    });
    expect(parsed.request_id).toBe('668ea92da2a19f7d2e72bf98bd530c41');
    expect('response' in parsed).toBe(false);
    // E um envelope sem `error` continua sendo recusado, como em toda operação.
    expect(shopeeConfirmLostPushSchema.safeParse({ request_id: 'x' }).success).toBe(false);
  });
});

describe('a configuração de push do app', () => {
  it('lê o exemplo minúsculo "suspended" sem enum nenhum', () => {
    // ⚠️ A página se contradiz: a descrição diz `Normal/Warning/Suspended` e o
    // exemplo dela mesma diz `"suspended"`. Um enum estrito jogaria fora
    // justamente a leitura que o monitor precisa registrar.
    const parsed = shopeeAppPushConfigSchema.parse({
      error: '',
      response: {
        callback_url: 'https://open.shopee.com/',
        live_push_status: 'suspended',
        suspended_time: 1577416181,
        blocked_shop_id: [10010, 20020, 30030],
        push_config_on_list: [1, 2, 3],
        push_config_off_list: [4, 5, 6],
      },
    });
    expect(parsed.response.live_push_status).toBe('suspended');
    expect(parsed.response.suspended_time).toBe(1577416181);
    expect(parsed.response.blocked_shop_id).toEqual([10010, 20020, 30030]);
  });

  it('um live_push_status que ninguém viu antes PARSEIA — quem decide é o leitor', () => {
    const parsed = shopeeAppPushConfigSchema.parse({
      error: '',
      response: { live_push_status: 'Throttled' },
    });
    expect(parsed.response.live_push_status).toBe('Throttled');
  });

  it('as listas ausentes viram null, NUNCA [] — "a Shopee não disse" não é "está vazia"', () => {
    // NEAR-MISS que importa: `[]` afirmaria que nenhum código está desligado, e
    // o monitor leria uma configuração que ninguém verificou como saudável.
    const parsed = shopeeAppPushConfigSchema.parse({ error: '', response: {} });
    expect(parsed.response.blocked_shop_id).toBeNull();
    expect(parsed.response.push_config_on_list).toBeNull();
    expect(parsed.response.push_config_off_list).toBeNull();
    expect(parsed.response.suspended_time).toBeNull();
    expect(parsed.response.callback_url).toBeNull();
    expect(parsed.response.live_push_status).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                      A listagem de pedidos (passo 4/5)                      */
/* -------------------------------------------------------------------------- */

describe('a página de get_order_list', () => {
  it('`more` é um boolean ESTRITO — "false" em string FALHA, nunca vira "drenado"', () => {
    // ⚠️ `more` é o ÚNICO sinal de término do laço: uma string coagida é truthy,
    // então o erro numa direção pagina para sempre e, na outra, trunca uma
    // janela em silêncio.
    expect(
      shopeeOrderListSchema.safeParse({
        error: '',
        response: { more: 'false', next_cursor: '', order_list: [] },
      }).success,
    ).toBe(false);
    expect(
      shopeeOrderListSchema.parse({
        error: '',
        response: { more: false, next_cursor: '', order_list: [] },
      }).response.more,
    ).toBe(false);
  });

  it('next_cursor "" e ausente são ambos aceitos', () => {
    // `""` é o sentinela de drenado da própria Shopee; ausente é o que uma
    // página pode simplesmente não mandar. Quem decide o que fazer com os dois é
    // a app — aqui os dois têm de PARSEAR.
    expect(
      shopeeOrderListSchema.parse({
        error: '',
        response: { more: false, next_cursor: '', order_list: [] },
      }).response.next_cursor,
    ).toBe('');
    expect(
      shopeeOrderListSchema.parse({ error: '', response: { more: false, order_list: [] } }).response
        .next_cursor,
    ).toBeNull();
  });

  it('tolera a linha nua {order_sn} e a linha completa, mas RECUSA um order_sn vazio', () => {
    // NEAR-MISS: a página devolve linhas nuas mesmo quando se pede
    // `response_optional_fields=order_status`, então os opcionais são nulos. Já
    // um `order_sn` em branco não é uma linha tolerável — ele é o único dado
    // desta operação, e todas as linhas em branco colapsariam numa identidade só.
    const parsed = shopeeOrderListSchema.parse({
      error: '',
      response: {
        more: true,
        next_cursor: '20',
        order_list: [
          { order_sn: '201218V2Y6E59M' },
          {
            order_sn: '2404098R48U37H',
            order_status: 'READY_TO_SHIP',
            booking_sn: '2404098R48U37H',
          },
        ],
      },
    });
    expect(parsed.response.order_list[0]?.order_status).toBeNull();
    expect(parsed.response.order_list[0]?.booking_sn).toBeNull();
    expect(parsed.response.order_list[1]?.order_status).toBe('READY_TO_SHIP');

    expect(
      shopeeOrderListSchema.safeParse({
        error: '',
        response: { more: false, next_cursor: '', order_list: [{ order_sn: '' }] },
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                 O detalhe do pedido e o escrow (passo 5)                    */
/* -------------------------------------------------------------------------- */

/** ⚠️ Inventado, no formato da Shopee. Nunca um pedido real. */
const ORDER_SN_DETALHE = '220810QSK8S7BX';

/** O mínimo que uma linha de `order_list` precisa ter para parsear. */
function linhaDetalhe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { order_sn: ORDER_SN_DETALHE, order_status: 'READY_TO_SHIP', ...extra };
}

function corpoDetalhe(...linhas: Record<string, unknown>[]) {
  return { error: '', response: { order_list: linhas } };
}

describe('o detalhe do pedido (get_order_detail)', () => {
  it('um número CITADO continua parseando — uma aspa não pode custar o pedido inteiro', () => {
    // ⚠️ A forma do #1087: um serializador que cita UM campo derrubava o recurso
    // todo, e o pedido ficava preso enquanto a fila repetia a mesma chamada.
    const parsed = shopeeOrderDetailSchema.parse(
      corpoDetalhe(
        linhaDetalhe({
          total_amount: '31.99',
          update_time: '1788973354',
          item_list: [{ item_id: '846056136', model_quantity_purchased: '2' }],
        }),
      ),
    );
    const linha = parsed.response.order_list[0]!;
    expect(linha.total_amount).toBe(31.99);
    expect(linha.update_time).toBe(1_788_973_354);
    expect(linha.item_list?.[0]?.item_id).toBe(846_056_136);
    expect(linha.item_list?.[0]?.model_quantity_purchased).toBe(2);
  });

  it('product_location_id parseia STRING e ARRAY — e os dois chegam na MESMA resposta', () => {
    // ⚠️ Fato medido no pedido de sandbox: array no item do pedido, string no
    // item do pacote, na mesma resposta. Dobrar um no outro perde metade.
    const parsed = shopeeOrderDetailSchema.parse(
      corpoDetalhe(
        linhaDetalhe({
          item_list: [{ item_id: 846_056_136, product_location_id: ['SGZ'] }],
          package_list: [{ package_number: 'OFG1', item_list: [{ product_location_id: 'SGZ' }] }],
        }),
      ),
    );
    const linha = parsed.response.order_list[0]!;
    expect(linha.item_list?.[0]?.product_location_id).toEqual(['SGZ']);
    expect(linha.package_list?.[0]?.item_list?.[0]?.product_location_id).toBe('SGZ');
  });

  it('⚠️ NEAR-MISS: um product_location_id de NÚMEROS é recusado — o campo é documentado string', () => {
    expect(
      shopeeOrderDetailSchema.safeParse(
        corpoDetalhe(linhaDetalhe({ item_list: [{ item_id: 1, product_location_id: [123] }] })),
      ).success,
    ).toBe(false);
  });

  it('parcel_chargeable_weight e parcel_chargeable_weight_gram sobrevivem SEPARADOS', () => {
    // ⚠️ A tabela documenta um, o exemplo manda o outro, e a unidade do primeiro
    // não está escrita em lugar nenhum. Declarar um só e ler como sinônimo é como
    // o legado escreveu gramas num campo de KG.
    const parsed = shopeeOrderDetailSchema.parse(
      corpoDetalhe(
        linhaDetalhe({
          package_list: [
            { package_number: 'A', parcel_chargeable_weight_gram: 500 },
            { package_number: 'B', parcel_chargeable_weight: 500 },
          ],
        }),
      ),
    );
    const pacotes = parsed.response.order_list[0]!.package_list!;
    expect(pacotes[0]?.parcel_chargeable_weight_gram).toBe(500);
    expect(pacotes[0]?.parcel_chargeable_weight).toBeNull();
    expect(pacotes[1]?.parcel_chargeable_weight).toBe(500);
    expect(pacotes[1]?.parcel_chargeable_weight_gram).toBeNull();
  });

  it('invoice_data distingue os TRÊS: null (não-BR), {} (sem NF-e) e populado', () => {
    // ⚠️ Um `.default({})` dobraria os dois primeiros, e é a diferença entre
    // "este pedido não é do Brasil" e "este pedido ainda não tem nota".
    const parsed = shopeeOrderDetailSchema.parse(
      corpoDetalhe(
        linhaDetalhe({ order_sn: 'A1', invoice_data: null }),
        linhaDetalhe({ order_sn: 'B2', invoice_data: {} }),
        linhaDetalhe({
          order_sn: 'C3',
          invoice_data: { number: '123', status: 'valid', access_key: '3525' },
        }),
      ),
    );
    const [naoBr, semNota, comNota] = parsed.response.order_list;
    expect(naoBr?.invoice_data).toBeNull();
    expect(semNota?.invoice_data).not.toBeNull();
    expect(semNota?.invoice_data?.number).toBeNull();
    expect(comNota?.invoice_data?.number).toBe('123');
    expect(comNota?.invoice_data?.status).toBe('valid');

    // E o campo AUSENTE cai no mesmo lugar do não-BR: null.
    expect(
      shopeeOrderDetailSchema.parse(corpoDetalhe(linhaDetalhe())).response.order_list[0]
        ?.invoice_data,
    ).toBeNull();
  });

  it('um order_status que ninguém viu antes PARSEIA — quem decide a escada é o mapeador', () => {
    // ⚠️ Um enum estrito transformaria um décimo-segundo status numa falha de
    // parse do pedido INTEIRO. A resposta certa é importar e deixar o mapeador
    // dizer "fora da escada" com um estado ENUMERADO.
    const parsed = shopeeOrderDetailSchema.parse(
      corpoDetalhe(linhaDetalhe({ order_status: 'SOMETHING_NEW' })),
    );
    expect(parsed.response.order_list[0]?.order_status).toBe('SOMETHING_NEW');
  });

  it('⚠️ NEAR-MISS: um order_sn em branco derruba a página, alto', () => {
    // Ele é a pré-imagem do id determinístico do pedido: em branco, TODAS as
    // linhas colapsam num documento só, em silêncio.
    expect(
      shopeeOrderDetailSchema.safeParse(corpoDetalhe(linhaDetalhe({ order_sn: '' }))).success,
    ).toBe(false);
    // ... e um order_status ausente também, porque a escada não tem o que ler.
    expect(
      shopeeOrderDetailSchema.safeParse({
        error: '',
        response: { order_list: [{ order_sn: ORDER_SN_DETALHE }] },
      }).success,
    ).toBe(false);
  });

  it('os ZEROS da Shopee chegam como zero, nunca como null — quem decide que zero é ausência é o leitor', () => {
    // ⚠️ Medido no pedido de sandbox: `actual_shipping_fee: 0` com o comprador
    // tendo pago 1,99. Um `??` nesses campos é um bug — e o schema não pode
    // esconder o zero, senão o leitor nem tem o que decidir.
    const parsed = shopeeOrderDetailSchema.parse(
      corpoDetalhe(
        linhaDetalhe({
          actual_shipping_fee: 0,
          estimated_shipping_fee: 1.99,
          edt_from: 0,
          edt_to: 0,
          pickup_done_time: 0,
          order_chargeable_weight_gram: 0,
        }),
      ),
    );
    const linha = parsed.response.order_list[0]!;
    expect(linha.actual_shipping_fee).toBe(0);
    expect(linha.estimated_shipping_fee).toBe(1.99);
    expect(linha.edt_from).toBe(0);
    expect(linha.edt_to).toBe(0);
    expect(linha.pickup_done_time).toBe(0);
    expect(linha.order_chargeable_weight_gram).toBe(0);

    // NEAR-MISS: AUSENTE é null, e é uma leitura diferente de zero.
    const semNada = shopeeOrderDetailSchema.parse(corpoDetalhe(linhaDetalhe())).response
      .order_list[0]!;
    expect(semNada.actual_shipping_fee).toBeNull();
    expect(semNada.edt_to).toBeNull();
  });

  it('model_id 0 é um VALOR (item sem variação), e ausente é null — os dois não se misturam', () => {
    const parsed = shopeeOrderDetailSchema.parse(
      corpoDetalhe(
        linhaDetalhe({
          item_list: [{ item_id: 1, model_id: 0 }, { item_id: 2 }],
        }),
      ),
    );
    const itens = parsed.response.order_list[0]!.item_list!;
    expect(itens[0]?.model_id).toBe(0);
    expect(itens[1]?.model_id).toBeNull();
  });

  it('`edt` carrega o TIPO que chegou, seja ele qual for — é o que responde o registro', () => {
    // O request pede o token `edt`; a resposta traz `edt_from`/`edt_to` e nenhum
    // `edt`. Carregado como `unknown` para que o leitor logue o tipo UMA vez, sem
    // mudar schema e sem chutar forma.
    const comObjeto = shopeeOrderDetailSchema.parse(
      corpoDetalhe(linhaDetalhe({ edt: { from: 1, to: 2 } })),
    ).response.order_list[0]!;
    expect(comObjeto.edt).toEqual({ from: 1, to: 2 });

    const comLista = shopeeOrderDetailSchema.parse(corpoDetalhe(linhaDetalhe({ edt: [1, 2] })))
      .response.order_list[0]!;
    expect(comLista.edt).toEqual([1, 2]);

    expect(
      shopeeOrderDetailSchema.parse(corpoDetalhe(linhaDetalhe())).response.order_list[0]?.edt,
    ).toBeNull();
  });

  it('pending_terms é lista de string quando pedido, e null quando NÃO foi pedido', () => {
    // ⚠️ `null` = "não perguntamos" (a flag não foi enviada); `[]` = "perguntamos
    // e não há". Um `.default([])` afirmaria a segunda coisa sempre.
    const comFlag = shopeeOrderDetailSchema.parse(
      corpoDetalhe(
        linhaDetalhe({ order_status: 'PENDING', pending_terms: ['SYSTEM_PENDING', 'KYC_PENDING'] }),
      ),
    ).response.order_list[0]!;
    expect(comFlag.pending_terms).toEqual(['SYSTEM_PENDING', 'KYC_PENDING']);

    expect(
      shopeeOrderDetailSchema.parse(corpoDetalhe(linhaDetalhe())).response.order_list[0]
        ?.pending_terms,
    ).toBeNull();
  });

  it('o endereço mascarado PARSEIA — julgar o valor não é papel do schema', () => {
    // As duas formas de máscara já vistas: as estrelas parciais do exemplo da
    // página (VN) e o `"****"` inteiro do pedido de sandbox. Nenhuma falha aqui;
    // quem recusa é `valorUtilizavel`, em packages/schemas.
    const parsed = shopeeOrderDetailSchema.parse(
      corpoDetalhe(
        linhaDetalhe({
          recipient_address: {
            name: 'P******n',
            phone: '******64',
            town: '',
            district: '',
            city: '',
            state: '',
            region: 'VN',
            zipcode: '',
            full_address: 'Ấp******',
          },
        }),
        linhaDetalhe({
          order_sn: 'SG1',
          region: 'SG',
          recipient_address: { name: '****', phone: '****', region: 'SG', zipcode: '138522' },
        }),
      ),
    );
    expect(parsed.response.order_list[0]?.recipient_address?.name).toBe('P******n');
    expect(parsed.response.order_list[1]?.recipient_address?.name).toBe('****');
    // ⚠️ A region do ENDEREÇO é mascarável; a do PEDIDO é a que se lê.
    expect(parsed.response.order_list[1]?.region).toBe('SG');
  });

  it('campos que a Shopee inventar amanhã atravessam pelo passthrough, sem falhar', () => {
    const parsed = shopeeOrderDetailSchema.parse(
      corpoDetalhe(
        linhaDetalhe({ campo_novo_da_shopee: 'x', item_list: [{ item_id: 1, novo: 2 }] }),
      ),
    );
    const linha = parsed.response.order_list[0]!;
    expect((linha as Record<string, unknown>).campo_novo_da_shopee).toBe('x');
    expect((linha.item_list![0] as unknown as Record<string, unknown>).novo).toBe(2);
  });
});

describe('o escrow do pedido (get_escrow_detail)', () => {
  function corpoEscrow(income: Record<string, unknown> = {}) {
    return {
      error: '',
      response: {
        order_sn: ORDER_SN_DETALHE,
        buyer_user_name: 'comprador-inventado',
        return_order_sn_list: [],
        order_income: income,
      },
    };
  }

  it('kit_items parseia como OBJETO singular e como ARRAY — o leitor é quem normaliza', () => {
    // ⚠️ A página tipa um objeto só; um kit de vários componentes não tem forma
    // documentada. Um schema só-objeto recusaria o kit real e custaria o dinheiro
    // do pedido inteiro.
    const objeto = shopeeEscrowDetailSchema.parse(
      corpoEscrow({
        items: [
          {
            item_id: 1,
            is_kit: true,
            kit_items: { original_product_id: 800062998, total_qty: 2 },
          },
        ],
      }),
    ).response.order_income!.items![0]!;
    expect(Array.isArray(objeto.kit_items)).toBe(false);
    expect((objeto.kit_items as { original_product_id: number | null }).original_product_id).toBe(
      800_062_998,
    );

    const lista = shopeeEscrowDetailSchema.parse(
      corpoEscrow({
        items: [
          {
            item_id: 1,
            is_kit: true,
            kit_items: [
              { original_product_id: 1, original_model_id: 10 },
              { original_product_id: 2, original_model_id: 20 },
            ],
          },
        ],
      }),
    ).response.order_income!.items![0]!;
    expect(Array.isArray(lista.kit_items)).toBe(true);
    expect((lista.kit_items as { original_model_id: number | null }[])[1]?.original_model_id).toBe(
      20,
    );
  });

  it('⚠️ NEAR-MISS: um id FRACIONÁRIO em kit_items é recusado — arredondar um id inventa um valor', () => {
    // O exemplo da página manda `0.1` em TODOS os ids do kit; é o valor de
    // preenchimento dela para float, não um dado. `wireInt()` recusa alto em vez
    // de arredondar para um id que ninguém consegue recuperar.
    const resultado = shopeeEscrowDetailSchema.safeParse(
      corpoEscrow({ items: [{ item_id: 1, kit_items: { original_product_id: 0.1 } }] }),
    );
    expect(resultado.success).toBe(false);
    expect(JSON.stringify(resultado.error?.issues)).toContain('kit_items');

    // ... e o mesmo id CITADO como inteiro passa, porque a tolerância é sobre a
    // aspa, nunca sobre o valor.
    expect(
      shopeeEscrowDetailSchema.parse(
        corpoEscrow({ items: [{ item_id: 1, kit_items: { original_product_id: '800062998' } }] }),
      ).response.order_income!.items![0]!.kit_items,
    ).toEqual({
      original_product_id: 800_062_998,
      original_model_id: null,
      total_qty: null,
      original_price: null,
      proportional_price: null,
    });
  });

  it('is_kit ausente é null ("não sabemos"), nunca false', () => {
    // O campo só existe para vendedor BR local. `false` afirmaria que a linha NÃO
    // é kit numa resposta que não fala sobre kits.
    const item = shopeeEscrowDetailSchema.parse(corpoEscrow({ items: [{ item_id: 1 }] })).response
      .order_income!.items![0]!;
    expect(item.is_kit).toBeNull();
    expect(item.kit_items).toBeNull();
  });

  it('discounted_price e order_discounted_price ficam SEPARADOS', () => {
    // A página nomeia um, a lista dos "subtotais" nomeia o outro. Dobrar os dois
    // faria o que a Shopee realmente manda ler `null` para sempre.
    const income = shopeeEscrowDetailSchema.parse(
      corpoEscrow({ order_discounted_price: 100, escrow_amount: 90 }),
    ).response.order_income!;
    expect(income.order_discounted_price).toBe(100);
    expect(income.discounted_price).toBeNull();
    expect(income.escrow_amount).toBe(90);
  });

  it('buyer_user_name NÃO é dobrado com o buyer_username do detalhe', () => {
    const parsed = shopeeEscrowDetailSchema.parse(corpoEscrow());
    expect(parsed.response.buyer_user_name).toBe('comprador-inventado');
    expect('buyer_username' in parsed.response).toBe(false);
  });

  it('dinheiro NEGATIVO parseia — a própria página manda final_shipping_fee: -10', () => {
    const income = shopeeEscrowDetailSchema.parse(
      corpoEscrow({
        items: [{ item_id: 1, seller_discount: -1.5, discounted_price: 15 }],
        buyer_paid_shipping_fee: 1.99,
      }),
    ).response.order_income!;
    expect(income.items![0]?.seller_discount).toBe(-1.5);
    expect(income.buyer_paid_shipping_fee).toBe(1.99);
  });

  it('os campos que NINGUÉM declarou atravessam pelo passthrough', () => {
    // ⚠️ `commission_fee` e `service_fee` estavam AQUI enquanto eram só passageiros;
    // o passo 6 os DECLAROU (com mais dezesseis), e a asserção deles mudou de casa
    // para `describe('os campos de tarifa do escrow (passo 6)')`. O que sobra aqui
    // é o que continua sem leitor: `order_adjustment` só existe quando há ajuste, e
    // a Shopee manda ~70 floats que ninguém nomeia.
    const parsed = shopeeEscrowDetailSchema.parse(
      corpoEscrow({ order_adjustment: [{ amount: 10.1 }], withholding_tax: 2.5 }),
    );
    const income = parsed.response.order_income as unknown as Record<string, unknown>;
    expect(income.order_adjustment).toEqual([{ amount: 10.1 }]);
    expect(income.withholding_tax).toBe(2.5);
  });

  it('order_income ausente é null — "não veio" não é "zerado"', () => {
    const parsed = shopeeEscrowDetailSchema.parse({
      error: '',
      response: { order_sn: ORDER_SN_DETALHE },
    });
    expect(parsed.response.order_income).toBeNull();
    expect(parsed.response.return_order_sn_list).toBeNull();
  });

  it('⚠️ NEAR-MISS: um order_sn em branco na resposta do escrow derruba o parse', () => {
    expect(
      shopeeEscrowDetailSchema.safeParse({ error: '', response: { order_sn: '' } }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*         O dinheiro do escrow e a liquidação (passo 6)                       */
/* -------------------------------------------------------------------------- */

/**
 * O corpo REAL que a Shopee devolveu para o pedido do sandbox de Singapura,
 * commitado em `apps/shopee/lib/shopee/fixtures/__wire__/`.
 *
 * ⚠️ Lido do arquivo, não copiado para cá. Uma cópia dos números seria o espelho
 * que a CLAUDE.md da raiz descreve: dois lugares afirmando o mesmo fato do wire,
 * livres para divergir devagar e ficarem os dois verdes. O arquivo é a
 * autoridade; se ele mudar de lugar, este teste QUEBRA, que é o sinal certo.
 */
const CORPO_ESCROW_SG: unknown = JSON.parse(
  readFileSync(
    new URL(
      '../../../../apps/shopee/lib/shopee/fixtures/__wire__/get_escrow_detail.qty2-sg.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

function rendaEscrow(income: Record<string, unknown> = {}, resto: Record<string, unknown> = {}) {
  return {
    error: '',
    response: { order_sn: ORDER_SN_DETALHE, order_income: income, ...resto },
  };
}

describe('os campos de tarifa do escrow (passo 6)', () => {
  it('16 — os 18 campos declarados leem o corpo REAL do sandbox SG: 16 valores e o par BR `net_*` em null', () => {
    const income = shopeeEscrowDetailSchema.parse(CORPO_ESCROW_SG).response.order_income!;

    // Os três da FAQ 479 — o que vira `tarifas` no pagamento.
    expect(income.commission_fee).toBe(0.65);
    expect(income.service_fee).toBe(0);
    expect(income.seller_transaction_fee).toBe(0.64);
    // O rollup e a metade dele que a Shopee também manda.
    expect(income.credit_card_transaction_fee).toBe(0.64);
    expect(income.buyer_transaction_fee).toBe(0);
    // O resto do bloco declarado.
    expect(income.escrow_amount).toBe(30.7);
    expect(income.escrow_amount_after_adjustment).toBe(30.7);
    expect(income.buyer_total_amount).toBe(31.99);
    expect(income.campaign_fee).toBe(0);
    expect(income.pix_discount).toBe(0);
    expect(income.seller_return_refund).toBe(0);
    expect(income.drc_adjustable_refund).toBe(0);
    expect(income.total_adjustment_amount).toBe(0);
    expect(income.shipping_seller_protection_fee_amount).toBe(0);
    expect(income.final_shipping_fee).toBe(0);
    expect(income.seller_order_processing_fee).toBe(0);
    expect(income.order_ams_commission_fee).toBe(0);
    expect(income.escrow_tax).toBe(0);

    // ⚠️ O par BR está AUSENTE deste corpo (é de Singapura), e ausente lê `null`
    // — "não veio", nunca "zero". Um `.default(0)` aqui faria uma tarifa líquida
    // BR não enviada parecer uma tarifa de verdade valendo nada.
    expect(income.net_commission_fee).toBeNull();
    expect(income.net_service_fee).toBeNull();
    expect(income.net_commission_fee).not.toBe(0);
  });

  it('16b — ⚠️ NEAR-MISS: `credit_card_transaction_fee` e `seller_transaction_fee` são campos SEPARADOS', () => {
    // ⚠️ No corpo SG os dois valem 0.64, porque `buyer_transaction_fee` é 0 e o
    // primeiro é definido pela página como a SOMA dos dois. Ou seja: naquele
    // corpo, trocar um pelo outro não muda nada. É por isso que a separação
    // precisa de um vetor onde eles DIFEREM.
    const income = shopeeEscrowDetailSchema.parse(
      rendaEscrow({
        seller_transaction_fee: 0.64,
        buyer_transaction_fee: 0.1,
        credit_card_transaction_fee: 0.74,
      }),
    ).response.order_income!;

    expect(income.seller_transaction_fee).toBe(0.64);
    expect(income.buyer_transaction_fee).toBe(0.1);
    expect(income.credit_card_transaction_fee).toBe(0.74);
    expect(income.credit_card_transaction_fee).not.toBe(income.seller_transaction_fee);
  });

  it('17 — `tenure_info_list` parseia nas TRÊS formas observadas, e `"N/A"` continua STRING', () => {
    // (1) A forma da página: UM objeto, `instalment_plan` string.
    const objeto = shopeeEscrowDetailSchema.parse(
      rendaEscrow({
        tenure_info_list: { payment_channel_name: 'Banco Inventado', instalment_plan: '3' },
      }),
    ).response.order_income!.tenure_info_list!;
    expect(Array.isArray(objeto)).toBe(false);
    const singular = objeto as { payment_channel_name: string | null; instalment_plan: unknown };
    expect(singular.payment_channel_name).toBe('Banco Inventado');
    // ⚠️ `z.string()` vem PRIMEIRO na união: `'3'` continua a STRING '3'.
    expect(singular.instalment_plan).toBe('3');
    expect(typeof singular.instalment_plan).toBe('string');
    expect(singular.instalment_plan).not.toBe(3);

    // (2) O anúncio 1080: ARRAY, `instalment_plan` INTEIRO.
    const lista = shopeeEscrowDetailSchema.parse(
      rendaEscrow({
        tenure_info_list: [
          { payment_channel_name: 'Banco Inventado', instalment_plan: 1 },
          { payment_channel_name: 'Outro Banco', instalment_plan: 3 },
        ],
      }),
    ).response.order_income!.tenure_info_list!;
    expect(Array.isArray(lista)).toBe(true);
    const entradas = lista as { instalment_plan: unknown }[];
    expect(entradas[0]?.instalment_plan).toBe(1);
    expect(entradas[1]?.instalment_plan).toBe(3);
    expect(typeof entradas[1]?.instalment_plan).toBe('number');

    // (3) O corpo REAL do sandbox: array de UM, `"N/A"`, sem canal.
    const real =
      shopeeEscrowDetailSchema.parse(CORPO_ESCROW_SG).response.order_income!.tenure_info_list!;
    expect(Array.isArray(real)).toBe(true);
    const doSandbox = real as { payment_channel_name: string | null; instalment_plan: unknown }[];
    expect(doSandbox).toHaveLength(1);
    // ⚠️ `"N/A"` é um VALOR, não um ausente. Quem dobra isso para 1 parcela é o
    // leitor em `apps/shopee`; o pacote registra o que chegou.
    expect(doSandbox[0]?.instalment_plan).toBe('N/A');
    expect(doSandbox[0]?.payment_channel_name).toBeNull();

    // E ausente é `null`, nunca uma lista vazia inventada.
    expect(
      shopeeEscrowDetailSchema.parse(rendaEscrow()).response.order_income!.tenure_info_list,
    ).toBeNull();
  });

  it('18 — ⚠️ `order_income.pix_discount` e `buyer_payment_info.discount_pix` NÃO são dobrados', () => {
    // Duas grafias, dois relógios: um se move até o pedido completar, o outro é
    // o instantâneo do checkout. Ler um pelo outro daria um número certo num
    // pedido calado e silenciosamente velho num pedido com reembolso.
    const parsed = shopeeEscrowDetailSchema.parse(
      rendaEscrow({ pix_discount: 5 }, { buyer_payment_info: { discount_pix: 0 } }),
    );
    expect(parsed.response.order_income!.pix_discount).toBe(5);
    expect(parsed.response.buyer_payment_info!.discount_pix).toBe(0);

    // NEAR-MISS na direção oposta: trocar os valores troca as leituras, então
    // nenhum dos dois está lendo o outro por acidente.
    const trocado = shopeeEscrowDetailSchema.parse(
      rendaEscrow({ pix_discount: 0 }, { buyer_payment_info: { discount_pix: 5 } }),
    );
    expect(trocado.response.order_income!.pix_discount).toBe(0);
    expect(trocado.response.buyer_payment_info!.discount_pix).toBe(5);

    // E o campo do outro lado não vaza para cá: `discount_pix` não existe em
    // `order_income` neste corpo, e continua indefinido em vez de virar 5.
    expect((trocado.response.order_income as unknown as Record<string, unknown>).discount_pix).toBe(
      undefined,
    );
  });

  it('19 — `buyer_payment_info` tem seis campos TIPADOS e o resto atravessa pelo passthrough', () => {
    const info = shopeeEscrowDetailSchema.parse(CORPO_ESCROW_SG).response.buyer_payment_info!;

    expect(info.is_paid_by_credit_card).toBe(false);
    expect(info.buyer_payment_method).toBe('Apple Pay');
    expect(info.buyer_total_amount).toBe(31.99);
    expect(info.icms_tax_amount).toBe(0);
    expect(info.iof_tax_amount).toBe(0);
    expect(info.discount_pix).toBe(0);
    // 33 chaves no corpo real; as outras 27 continuam chegando.
    expect((info as unknown as Record<string, unknown>).vat).toBe(0);
    expect((info as unknown as Record<string, unknown>).merchant_subtotal).toBe(30);

    // ⚠️ `null` num pedido não-BR: a CHAVE vem, o valor é nulo. Distinto de
    // "não veio chave nenhuma", e as duas leituras dão `null` sem inventar `{}`.
    expect(
      shopeeEscrowDetailSchema.parse(rendaEscrow({}, { buyer_payment_info: null })).response
        .buyer_payment_info,
    ).toBeNull();
    expect(shopeeEscrowDetailSchema.parse(rendaEscrow()).response.buyer_payment_info).toBeNull();
  });

  it('19b — ⚠️ NEAR-MISS: os dois `buyer_total_amount` podem DISCORDAR e cada um continua legível', () => {
    // O de `buyer_payment_info` é o instantâneo INICIAL do checkout ("not updated
    // after return/refund"); o de `order_income` se move. Dobrá-los faria um
    // pedido reembolsado ler o número errado sem nada dizer.
    const parsed = shopeeEscrowDetailSchema.parse(
      rendaEscrow(
        { buyer_total_amount: 20 },
        { buyer_payment_info: { buyer_total_amount: 31.99 } },
      ),
    );
    expect(parsed.response.order_income!.buyer_total_amount).toBe(20);
    expect(parsed.response.buyer_payment_info!.buyer_total_amount).toBe(31.99);
  });

  it('20 — números CITADOS parseiam nos dois schemas novos; um id fracionário NÃO é arredondado', () => {
    // A tolerância do #1087: um serializador que cita UM campo não pode custar o
    // dinheiro do pedido nem a semana inteira de liquidação.
    const income = shopeeEscrowDetailSchema.parse(
      rendaEscrow({ escrow_amount: '30.7', commission_fee: '0.65', escrow_tax: '0' }),
    ).response.order_income!;
    expect(income.escrow_amount).toBe(30.7);
    expect(income.commission_fee).toBe(0.65);
    expect(income.escrow_tax).toBe(0);

    const page = shopeeEscrowListSchema.parse({
      error: '',
      response: {
        more: false,
        escrow_list: [
          { order_sn: ORDER_SN_DETALHE, payout_amount: '30.7', escrow_release_time: '1651849648' },
        ],
      },
    }).response;
    expect(page.escrow_list[0]?.payout_amount).toBe(30.7);
    expect(page.escrow_list[0]?.escrow_release_time).toBe(1_651_849_648);

    // ⚠️ NEAR-MISS: a tolerância é sobre a ASPA, nunca sobre o valor. Um
    // `escrow_release_time` fracionário é recusado por `wireInt()` e a linha
    // inteira vira a sentinela `null` — arredondar um instante de liberação
    // inventaria a marca-d'água da liquidação.
    const comFracao = shopeeEscrowListSchema.parse({
      error: '',
      response: {
        more: false,
        escrow_list: [
          { order_sn: ORDER_SN_DETALHE, payout_amount: 1, escrow_release_time: '1651849648.5' },
        ],
      },
    }).response;
    expect(comFracao.escrow_list[0]).toBeNull();
  });

  it('21 — dinheiro NEGATIVO parseia: a própria página manda `final_shipping_fee: -10`', () => {
    // Nenhum limite é declarado em campo nenhum deste bloco, e é deliberado: um
    // `.min(0)` faria a página recusar o exemplo dela mesma.
    const income = shopeeEscrowDetailSchema.parse(
      rendaEscrow({ final_shipping_fee: -10, total_adjustment_amount: -2.5 }),
    ).response.order_income!;
    expect(income.final_shipping_fee).toBe(-10);
    expect(income.total_adjustment_amount).toBe(-2.5);

    // E citado também, pela mesma razão do teste 20.
    expect(
      shopeeEscrowDetailSchema.parse(rendaEscrow({ final_shipping_fee: '-10' })).response
        .order_income!.final_shipping_fee,
    ).toBe(-10);
  });
});

/* -------------------------------------------------------------------------- */
/*                   O detalhe do pacote (passo 7)                             */
/* -------------------------------------------------------------------------- */

/** ⚠️ Inventado. Nunca um package_number real. */
const PACOTE = 'OFG242672552205937';
const PACOTE_2 = 'OFG242672552205938';
const ORDER_SN_PACOTE = '220831EGF1JMXF';

/** Uma linha mínima e VÁLIDA — só as duas identidades estritas. */
function linhaPacote(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { order_sn: ORDER_SN_PACOTE, package_number: PACOTE, ...extra };
}

function corpoPacote(...linhas: unknown[]): Record<string, unknown> {
  return { error: '', request_id: 'req-pacote', response: { package_list: linhas } };
}

/**
 * Os OITO campos que esta página traz e que o schema DELIBERADAMENTE não
 * declara — sete no nível do pacote e `prescription_reject_reason` um nível
 * abaixo, no item.
 */
const CHAVES_PII_NAO_DECLARADAS = [
  'recipient_address',
  'driver_info',
  'virtual_contact_number',
  'package_query_number',
  'prescription_images',
  'pharmacist_name',
  'buyer_proof_of_collection',
  'prescription_reject_reason',
] as const;

describe('o detalhe do pacote (get_package_detail, passo 7)', () => {
  it('1 — a linha RECUSA um `order_sn` em branco e um `package_number` em branco, alto e claro', () => {
    // ⚠️ As duas são identidades: a primeira é a pré-imagem do id determinístico
    // do pedido, a segunda é por onde o chamador reconcilia. Uma em branco
    // colapsaria todas essas linhas num pacote só.
    const semPedido = shopeePackageDetailRowSchema.safeParse(linhaPacote({ order_sn: '' }));
    expect(semPedido.success).toBe(false);
    expect(semPedido.error?.issues.map((i) => i.path.join('.'))).toContain('order_sn');

    const semPacote = shopeePackageDetailRowSchema.safeParse(linhaPacote({ package_number: '' }));
    expect(semPacote.success).toBe(false);
    expect(semPacote.error?.issues.map((i) => i.path.join('.'))).toContain('package_number');

    // ÂNCORA: a MESMA linha com as duas identidades preenchidas parseia.
    expect(shopeePackageDetailRowSchema.safeParse(linhaPacote()).success).toBe(true);
  });

  it('2 — `fulfillment_status` aceita um token que ninguém viu: quem julga é a dobra, não o schema', () => {
    // ⚠️ Um décimo-segundo token inventado pela Shopee amanhã não pode derrubar
    // a leitura de remessa do pedido inteiro. O leitor dobra e registra o token
    // desconhecido; o schema só transporta.
    const linha = shopeePackageDetailRowSchema.parse(
      linhaPacote({ fulfillment_status: 'LOGISTICS_TELEPORTED' }),
    );
    expect(linha.fulfillment_status).toBe('LOGISTICS_TELEPORTED');

    // E os onze documentados continuam passando, um a um.
    for (const token of SHOPEE_PACKAGE_FULFILLMENT_STATUS) {
      expect(
        shopeePackageDetailRowSchema.parse(linhaPacote({ fulfillment_status: token }))
          .fulfillment_status,
      ).toBe(token);
    }

    // Ausente é `null`, nunca uma string vazia inventada.
    expect(shopeePackageDetailRowSchema.parse(linhaPacote()).fulfillment_status).toBeNull();
  });

  it('3 — `tracking_number: "-"` sobrevive VERBATIM: a sentinela é da app, não do schema', () => {
    // ⚠️ Normalizar aqui esconderia de um fixture capturado exatamente o fato de
    // wire que o fixture existe para registrar. Esta página manda `-` em
    // `tracking_number`, `item_sku`, `model_sku` e `virtual_contact_number`.
    const linha = shopeePackageDetailRowSchema.parse(
      linhaPacote({
        tracking_number: '-',
        item_list: [{ item_id: 2_200_149_592, item_sku: '-', model_sku: '-' }],
      }),
    );
    expect(linha.tracking_number).toBe('-');
    expect(linha.item_list?.[0]?.item_sku).toBe('-');
    expect(linha.item_list?.[0]?.model_sku).toBe('-');

    // NEAR-MISS: um número REAL com traço no meio atravessa igualzinho — nada
    // aqui olha para dentro do valor.
    expect(
      shopeePackageDetailRowSchema.parse(linhaPacote({ tracking_number: 'BR-123' }))
        .tracking_number,
    ).toBe('BR-123');
  });

  it('4 — um `update_time` CITADO parseia; `"1.5e9"` NÃO — a tolerância é sobre a aspa, nunca sobre a forma', () => {
    // A tolerância do #1087: um serializador que cita UM campo não pode custar o
    // pacote inteiro. Mas um expoente é um palpite sobre o que o provedor quis
    // dizer, e um instante inventado é pior que uma linha recusada.
    const citado = shopeePackageDetailRowSchema.parse(
      linhaPacote({ update_time: '1661950674', ship_by_date: '1662209873' }),
    );
    expect(citado.update_time).toBe(1_661_950_674);
    expect(citado.ship_by_date).toBe(1_662_209_873);

    const expoente = shopeePackageDetailRowSchema.safeParse(linhaPacote({ update_time: '1.5e9' }));
    expect(expoente.success).toBe(false);
    expect(expoente.error?.issues.map((i) => i.path.join('.'))).toContain('update_time');

    // E na LISTA, a linha com expoente vira a sentinela `null` — as outras ficam.
    const pagina = shopeePackageDetailSchema.parse(
      corpoPacote(linhaPacote({ update_time: '1.5e9' }), linhaPacote({ package_number: PACOTE_2 })),
    ).response;
    expect(pagina.package_list[0]).toBeNull();
    expect(pagina.package_list[1]?.package_number).toBe(PACOTE_2);
  });

  it('5 — o zero-fill sobrevive como `0`, nunca como `null`: quem decide que zero é ausência é o leitor', () => {
    // ⚠️ A Shopee preenche numéricos ausentes com zero, e o exemplo desta página
    // manda `tracking_number_expiration_date: 0`, `pickup_done_time: 0`,
    // `parcel_chargeable_weight_gram: 0` e `group_shipment_id: 0`. Um `??` em
    // qualquer um deles é um bug — e `logistics_channel_id: 0` como canal é um
    // canal que não existe.
    const linha = shopeePackageDetailRowSchema.parse(
      linhaPacote({
        ship_by_date: 0,
        logistics_channel_id: 0,
        pickup_done_time: 0,
        group_shipment_id: 0,
        parcel_chargeable_weight_gram: 0,
      }),
    );
    expect(linha.ship_by_date).toBe(0);
    expect(linha.logistics_channel_id).toBe(0);
    expect(linha.pickup_done_time).toBe(0);
    expect(linha.group_shipment_id).toBe(0);
    expect(linha.parcel_chargeable_weight_gram).toBe(0);

    // NEAR-MISS: AUSENTE é `null`, e os dois casos continuam distinguíveis.
    const vazia = shopeePackageDetailRowSchema.parse(linhaPacote());
    expect(vazia.ship_by_date).toBeNull();
    expect(vazia.logistics_channel_id).toBeNull();
  });

  it('6 — os três arrays têm 11 / 13 / 36 membros, e o de 13 é superconjunto ESTRITO do de 11 pelos dois valores nomeados', () => {
    expect(SHOPEE_PACKAGE_FULFILLMENT_STATUS).toHaveLength(11);
    expect(SHOPEE_LOGISTICS_STATUS).toHaveLength(13);
    expect(SHOPEE_TRACKING_LOGISTICS_STATUS).toHaveLength(36);

    // Cada um sem repetição — uma lista transcrita à mão é onde um valor duplica.
    expect(new Set(SHOPEE_PACKAGE_FULFILLMENT_STATUS).size).toBe(11);
    expect(new Set(SHOPEE_LOGISTICS_STATUS).size).toBe(13);
    expect(new Set(SHOPEE_TRACKING_LOGISTICS_STATUS).size).toBe(36);

    // ⚠️ O delta do `guide 229`, valor a valor: "Due to legacy logic, the package
    // logistics status in get_order_detail will return 2 additional values".
    const extras = SHOPEE_LOGISTICS_STATUS.filter(
      (v) => !(SHOPEE_PACKAGE_FULFILLMENT_STATUS as readonly string[]).includes(v),
    );
    expect(extras).toEqual(['LOGISTICS_PENDING_ARRANGE', 'LOGISTICS_COD_REJECTED']);
    // E nada do lado de 11 ficou de fora do de 13.
    expect(
      SHOPEE_PACKAGE_FULFILLMENT_STATUS.filter(
        (v) => !(SHOPEE_LOGISTICS_STATUS as readonly string[]).includes(v),
      ),
    ).toEqual([]);
  });

  it('7 — ⚠️ `FAILED_DELIVERED` está no array de rastreio e NÃO no de logística — as duas listas não são a mesma', () => {
    // A página do `get_tracking_info` manda "See Data Definition - LogisticsStatus"
    // para os DOIS campos chamados `logistics_status`, e o próprio exemplo dela
    // usa `FAILED_DELIVERED`, que não é membro da lista de 13. Ler um valor
    // POR EVENTO contra `LogisticsStatus` recusaria todos os 36.
    expect(SHOPEE_TRACKING_LOGISTICS_STATUS).toContain('FAILED_DELIVERED');
    expect(SHOPEE_LOGISTICS_STATUS as readonly string[]).not.toContain('FAILED_DELIVERED');

    // NEAR-MISS na direção oposta: nenhum token `LOGISTICS_*` está na lista de
    // rastreio, e os dois vocabulários não se encostam em valor nenhum.
    expect(SHOPEE_TRACKING_LOGISTICS_STATUS.filter((v) => v.startsWith('LOGISTICS_'))).toEqual([]);
    expect(
      SHOPEE_LOGISTICS_STATUS.filter((v) =>
        (SHOPEE_TRACKING_LOGISTICS_STATUS as readonly string[]).includes(v),
      ),
    ).toEqual([]);
  });

  it('8 — ⚠️ nenhuma das OITO chaves de PII é chave do `.shape`, e um corpo que as traz PARSEIA assim mesmo', () => {
    // ⚠️ As duas metades são a decisão: a ausência é o que impede um leitor de
    // alcançá-las por um TIPO, e o passthrough é o que faz um fixture capturado
    // ainda registrá-las (o `redact.ts` percorre o JSON, não o schema).
    const declaradas = Object.keys(shopeePackageDetailRowSchema.shape);
    for (const chave of CHAVES_PII_NAO_DECLARADAS) {
      expect(declaradas).not.toContain(chave);
    }
    // `prescription_reject_reason` também não é chave do ITEM.
    expect(Object.keys(shopeePackageDetailItemSchema.shape)).not.toContain(
      'prescription_reject_reason',
    );

    // ÂNCORA: o `.shape` NÃO está vazio — as que são para estar, estão.
    expect(declaradas).toContain('tracking_number');
    expect(declaradas).toContain('fulfillment_status');
    expect(declaradas).toContain('is_shipment_arranged');

    // E o corpo real da página, com todas elas, continua sendo uma linha válida.
    const linha = shopeePackageDetailRowSchema.parse(
      linhaPacote({
        recipient_address: { name: 'b***r', phone: '******78', geolocation: { latitude: -23.5 } },
        driver_info: { driver_name: '', driver_phone: '', driver_status: 'Driver is on the way' },
        virtual_contact_number: '-',
        package_query_number: 'false',
        prescription_images: ['-'],
        pharmacist_name: '-',
        buyer_proof_of_collection: ['-'],
        item_list: [{ item_id: 1, prescription_reject_reason: '-' }],
      }),
    );
    expect(linha.package_number).toBe(PACOTE);
    // Elas chegam — mas só atrás de um cast explícito, nunca por um campo tipado.
    expect((linha as unknown as Record<string, unknown>).driver_info).toBeDefined();
    expect((linha as unknown as Record<string, unknown>).virtual_contact_number).toBe('-');
  });

  it('9 — o item do pacote CONCORDA com o do pedido nas seis chaves comuns e acrescenta exatamente duas', () => {
    // ⚠️ Estendido em vez de re-declarado: as seis compartilhadas não podem
    // divergir, e as duas novas são as únicas que esta página acrescenta e que
    // uma reconciliação pacote↔linha quereria.
    const doPedido = Object.keys(shopeePackageItemSchema.shape).sort();
    const doPacote = Object.keys(shopeePackageDetailItemSchema.shape).sort();

    expect(doPedido).toHaveLength(6);
    expect(doPacote).toHaveLength(8);
    for (const chave of doPedido) expect(doPacote).toContain(chave);
    expect(doPacote.filter((c) => !doPedido.includes(c))).toEqual(['item_sku', 'model_sku']);

    // E o comportamento compartilhado é o MESMO: `product_location_id` aceita as
    // duas formas nos dois schemas (string no pacote, array no item do pedido).
    expect(
      shopeePackageDetailItemSchema.parse({ item_id: 1, product_location_id: 'BR-SP' })
        .product_location_id,
    ).toBe('BR-SP');
    expect(
      shopeePackageDetailItemSchema.parse({ item_id: 1, product_location_id: ['A', 'B'] })
        .product_location_id,
    ).toEqual(['A', 'B']);
  });

  it('10 — `wrappedOp` EXIGE `response`: o mesmo corpo debaixo de `data` falha', () => {
    // ⚠️ Os três invólucros não são intercambiáveis, e é o schema da operação
    // que decide qual — não uma flag no cliente.
    expect(shopeePackageDetailSchema.safeParse(corpoPacote(linhaPacote())).success).toBe(true);

    const sobData = shopeePackageDetailSchema.safeParse({
      error: '',
      data: { package_list: [linhaPacote()] },
    });
    expect(sobData.success).toBe(false);
    expect(sobData.error?.issues.map((i) => i.path.join('.'))).toContain('response');

    // E sem `package_list` nenhuma a página é uma lista VAZIA, não um corpo ruim.
    expect(
      shopeePackageDetailSchema.parse({ error: '', response: {} }).response.package_list,
    ).toEqual([]);
  });

  it('11 — uma chave que a Shopee inventar amanhã atravessa em TODOS os níveis', () => {
    const parsed = shopeePackageDetailSchema.parse({
      error: '',
      campo_novo_no_envelope: 1,
      response: {
        campo_novo_no_payload: 2,
        package_list: [
          linhaPacote({
            campo_novo_na_linha: 3,
            item_list: [{ item_id: 1, campo_novo_no_item: 4 }],
            status_info_tag: { tag_id: 2, timestamp: 1_662_209_873, campo_novo_na_tag: 5 },
            invoice_pending: { status: 'pending', campo_novo_na_nota: 6 },
          }),
        ],
      },
    });

    const comoRegistro = parsed as unknown as Record<string, unknown>;
    expect(comoRegistro.campo_novo_no_envelope).toBe(1);
    expect((parsed.response as unknown as Record<string, unknown>).campo_novo_no_payload).toBe(2);

    const linha = parsed.response.package_list[0]!;
    expect((linha as unknown as Record<string, unknown>).campo_novo_na_linha).toBe(3);
    expect((linha.item_list![0] as unknown as Record<string, unknown>).campo_novo_no_item).toBe(4);
    expect((linha.status_info_tag as unknown as Record<string, unknown>).campo_novo_na_tag).toBe(5);
    expect((linha.invoice_pending as unknown as Record<string, unknown>).campo_novo_na_nota).toBe(
      6,
    );

    // E o que É tipado nesses dois blocos continua sendo lido.
    expect(linha.status_info_tag?.tag_id).toBe(2);
    expect(linha.status_info_tag?.timestamp).toBe(1_662_209_873);
    expect(linha.invoice_pending?.status).toBe('pending');
    expect(linha.invoice_pending?.pending_reason).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                     As quatro leituras de item (passo 9)                    */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ Ids de FIXTURE. Os dois que vêm dos samples das próprias páginas públicas
 * da Shopee (`2500139861`, `2000458802`) são exemplos de documentação, não ids
 * de loja nenhuma.
 */
const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;

/** O CÓDIGO-FONTE do módulo, para as asserções que só a fonte pode fazer. */
const FONTE_TYPES = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');

/** O trecho do passo 9 — do marcador de seção até o fim do arquivo. */
const SECAO_PASSO_9 = FONTE_TYPES.slice(FONTE_TYPES.indexOf('The item reads (step 9)'));

/**
 * ⚠️ SÓ as linhas de CÓDIGO. As asserções de fonte abaixo falam de DECLARAÇÕES,
 * e os docblocks deste módulo citam de propósito o que ele NÃO declara —
 * `promotion_id`, o rename obsoleto `unit`, o `z.number()` que seria o defeito.
 * Varrer a prosa junto transformaria cada explicação numa falha.
 */
function semComentarios(trecho: string): string {
  return trecho
    .split('\n')
    .filter((linha) => !/^\s*(\/\/|\/\*|\*)/.test(linha))
    .join('\n');
}

const CODIGO_PASSO_9 = semComentarios(SECAO_PASSO_9);

function trechoEntre(de: string, ate: string): string {
  const inicio = SECAO_PASSO_9.indexOf(de);
  const fim = SECAO_PASSO_9.indexOf(ate);
  expect(inicio).toBeGreaterThan(-1);
  expect(fim).toBeGreaterThan(inicio);
  return semComentarios(SECAO_PASSO_9.slice(inicio, fim));
}

function corpoItemList(payload: Record<string, unknown> = {}) {
  return {
    error: '',
    request_id: 'req-item-list',
    response: { item: [], total_count: 19, has_next_page: false, next_offset: 0, ...payload },
  };
}

function linhaItemBase(extra: Record<string, unknown> = {}) {
  return { item_id: ITEM_ID, item_name: 'Vestido longo', ...extra };
}

function corpoItemBase(payload: Record<string, unknown> = {}, linha: Record<string, unknown> = {}) {
  return {
    error: '',
    request_id: 'req-item-base',
    response: { item_list: [linhaItemBase(linha)], ...payload },
  };
}

function corpoModelList(payload: Record<string, unknown> = {}) {
  return { error: '', request_id: 'req-model', response: { model: [], ...payload } };
}

function corpoKit(produto: Record<string, unknown> | null = {}) {
  return {
    error: '',
    request_id: 'req-kit',
    response: {
      product_info: produto === null ? null : { item_id: ITEM_ID, model_list: [], ...produto },
    },
  };
}

describe('as quatro leituras de item (passo 9)', () => {
  it('1 — get_item_list desembrulha `response` e preserva `has_next_page` intacto', () => {
    const paginado = shopeeItemListSchema.parse(
      corpoItemList({
        item: [{ item_id: ITEM_ID, item_status: 'NORMAL', update_time: 1_608_128_470 }],
        has_next_page: true,
        next_offset: 10,
      }),
    );
    expect(paginado.response.has_next_page).toBe(true);
    expect(paginado.response.next_offset).toBe(10);
    expect(paginado.response.item[0]!.item_id).toBe(ITEM_ID);
    // O envelope segue no objeto de fora, nunca dentro do payload.
    expect('error' in paginado.response).toBe(false);
  });

  it('2 — ⛔ NEAR-MISS: `has_next_page: "false"` (STRING) derruba a página — nada coage o sinal de parada', () => {
    // ⚠️ Coagida para `true` a varredura gira para sempre; coagida para `false`
    // ela trunca o catálogo EM SILÊNCIO. Falhar é a única saída legível.
    const lido = shopeeItemListSchema.safeParse(corpoItemList({ has_next_page: 'false' }));
    expect(lido.success).toBe(false);
    expect(lido.error?.issues.map((i) => i.path.join('.'))).toContain('response.has_next_page');

    // ÂNCORA: o booleano de verdade passa — sem isto o teste passaria com um
    // schema que recusasse tudo.
    expect(shopeeItemListSchema.safeParse(corpoItemList({ has_next_page: false })).success).toBe(
      true,
    );
  });

  it('3 — uma linha SEM `tag` parseia: o campo é de 2024 e lojas antigas não o têm', () => {
    const paginado = shopeeItemListSchema.parse(
      corpoItemList({ item: [{ item_id: ITEM_ID, item_status: 'NORMAL' }] }),
    );
    expect(paginado.response.item[0]!.tag).toBeNull();
  });

  it('4 — `tag.kit: false` continua sendo `false`, nunca vira ausência', () => {
    // ⚠️ `tag.kit` é o ÚNICO canal de descoberta de kit que existe. Dobrar
    // `false` em `null` apagaria a diferença entre "não é kit" e "não sei".
    const paginado = shopeeItemListSchema.parse(
      corpoItemList({ item: [{ item_id: ITEM_ID, tag: { kit: false } }] }),
    );
    expect(paginado.response.item[0]!.tag?.kit).toBe(false);
    expect(paginado.response.item[0]!.tag).not.toBeNull();
  });

  it('5 — `total_count` ausente vira `null` e não quebra a página', () => {
    const paginado = shopeeItemListSchema.parse(
      corpoItemList({ total_count: undefined, item: [{ item_id: ITEM_ID }] }),
    );
    expect(paginado.response.total_count).toBeNull();
    expect(paginado.response.item).toHaveLength(1);
  });

  it('5b — a página REAL do sandbox parseia: `next` é uma STRING vazia e `next_offset` está AUSENTE', () => {
    // ⚠️ MEDIDO 2026-09-16: com page_size 10 numa loja de 1 item a resposta
    // trouxe `has_next_page: false`, `next: ""` e NENHUM `next_offset`; com
    // page_size 1 (página CHEIA) trouxe `next_offset: 1`. `next` não está em
    // página nenhuma da documentação. As duas chaves são declaradas para que
    // nenhuma das duas formas derrube a varredura.
    const paginado = shopeeItemListSchema.parse(
      corpoItemList({
        item: [
          {
            item_id: ITEM_ID,
            item_status: 'NORMAL',
            update_time: 1_608_128_470,
            tag: { kit: false },
          },
        ],
        total_count: 1,
        has_next_page: false,
        next: '',
        next_offset: undefined,
      }),
    );
    expect(paginado.response.next).toBe('');
    expect(paginado.response.next_offset).toBeNull();
    expect(paginado.response.has_next_page).toBe(false);

    // A página CHEIA traz o `next_offset` numérico ao lado do `next` vazio.
    const cheia = shopeeItemListSchema.parse(
      corpoItemList({ has_next_page: false, next: '', next_offset: 1 }),
    );
    expect(cheia.response.next_offset).toBe(1);
  });

  it('5c — `deboost` chega como a STRING "FALSE" no sandbox e a página NÃO cai; o booleano documentado também passa', () => {
    // ⚠️ MEDIDO 2026-09-16: um `z.boolean()` aqui recusou a página inteira
    // (`ShopeeSchemaError` em `response.item_list[].deboost`) — e com ela toda
    // importação. Ninguém lê o campo; as duas grafias sobrevivem verbatim.
    const texto = shopeeItemBaseInfoSchema.parse(corpoItemBase({}, { deboost: 'FALSE' }));
    expect(texto.response.item_list[0]!.deboost).toBe('FALSE');
    const booleano = shopeeItemBaseInfoSchema.parse(corpoItemBase({}, { deboost: true }));
    expect(booleano.response.item_list[0]!.deboost).toBe(true);
    const ausente = shopeeItemBaseInfoSchema.parse(corpoItemBase({}, {}));
    expect(ausente.response.item_list[0]!.deboost).toBeNull();
  });

  it('6 — get_item_base_info lê `tax_info` DENTRO do item (o sample da página)', () => {
    const lido = shopeeItemBaseInfoSchema.parse(
      corpoItemBase({}, { tax_info: { ncm: '61091000', origin: '0' } }),
    );
    expect(lido.response.item_list[0]!.tax_info?.ncm).toBe('61091000');
    expect(lido.response.item_list[0]!.tax_info?.origin).toBe('0');
  });

  it('7 — get_item_base_info lê `tax_info` IRMÃO de `item_list` (a tabela da página)', () => {
    const lido = shopeeItemBaseInfoSchema.parse(
      corpoItemBase({ tax_info: { ncm: '61091000', cest: '00' } }),
    );
    expect(lido.response.tax_info?.ncm).toBe('61091000');
    // A posição do item continua existindo, vazia — as duas são declaradas.
    expect(lido.response.item_list[0]!.tax_info).toBeNull();
  });

  it('8 — ⛔ NEAR-MISS: um `tax_info` em NENHUMA das duas posições vira `null`, não erro', () => {
    // ⚠️ Declarar o campo em UM lugar só é a falha silenciosa: sob a leitura
    // errada, `tax_info` chega `null` para TODO item e o bloco fiscal some sem
    // erro nenhum em lugar nenhum.
    const lido = shopeeItemBaseInfoSchema.parse(corpoItemBase());
    expect(lido.response.tax_info).toBeNull();
    expect(lido.response.item_list[0]!.tax_info).toBeNull();
  });

  it('9 — a mesma tolerância vale para os CINCO campos ambíguos, nas duas posições', () => {
    const valores: Record<ShopeeNestingAmbiguousKey, unknown> = {
      tax_info: { ncm: '61091000' },
      description_type: 'extended',
      description_info: {
        extended_description: { field_list: [{ field_type: 'text', text: 'a' }] },
      },
      stock_info_v2: { seller_stock: [{ location_id: 'BR', stock: 7 }] },
      complaint_policy: { warranty_time: 'ONE_YEAR' },
    };

    for (const chave of SHOPEE_NESTING_AMBIGUOUS_KEYS) {
      const noItem = shopeeItemBaseInfoSchema.parse(
        corpoItemBase({}, { [chave]: valores[chave] }),
      ).response;
      expect(noItem.item_list[0]![chave]).not.toBeNull();
      expect(noItem[chave]).toBeNull();

      const naRaiz = shopeeItemBaseInfoSchema.parse(
        corpoItemBase({ [chave]: valores[chave] }),
      ).response;
      expect(naRaiz[chave]).not.toBeNull();
      expect(naRaiz.item_list[0]![chave]).toBeNull();
    }
    expect(SHOPEE_NESTING_AMBIGUOUS_KEYS).toHaveLength(5);
  });

  it('10 — `weight` chega como STRING: `"10.02"` não é coagido a número', () => {
    // ⚠️ Do lado da escrita a Shopee quer um float. `wireNumber()` aqui teria
    // SUCESSO e escondido a assimetria de quem for publicar.
    const lido = shopeeItemBaseInfoSchema.parse(corpoItemBase({}, { weight: '10.02' }));
    expect(lido.response.item_list[0]!.weight).toBe('10.02');
    expect(typeof lido.response.item_list[0]!.weight).toBe('string');
  });

  it('11 — `dimension` são inteiros em CM e um ausente vira `null`, nunca 0', () => {
    const lido = shopeeItemBaseInfoSchema.parse(
      corpoItemBase({}, { dimension: { package_length: 11, package_width: 22 } }),
    );
    const dim = lido.response.item_list[0]!.dimension!;
    expect(dim.package_length).toBe(11);
    expect(dim.package_width).toBe(22);
    // ⚠️ Um pacote de 0 cm de altura não é a mesma afirmação que uma altura
    // nunca preenchida.
    expect(dim.package_height).toBeNull();
  });

  it('12 — `ncm: "00"` e `gtin_code: "00"` sobrevivem como strings de DOIS zeros', () => {
    const lido = shopeeItemBaseInfoSchema.parse(
      corpoItemBase({}, { gtin_code: '00', tax_info: { ncm: '00', cest: '00' } }),
    );
    const linha = lido.response.item_list[0]!;
    expect(linha.gtin_code).toBe('00');
    expect(linha.tax_info?.ncm).toBe('00');
    expect(linha.tax_info?.cest).toBe('00');
    // ⛔ NEAR-MISS: `'0'` é outra string, e não vira a mesma coisa.
    const zeroSolto = shopeeItemBaseInfoSchema.parse(corpoItemBase({}, { gtin_code: '0' }));
    expect(zeroSolto.response.item_list[0]!.gtin_code).toBe('0');
  });

  it('13 — ⛔ NEAR-MISS: nenhum campo de `tax_info` é numérico — `origin: "0"` não vira 0', () => {
    // ⚠️ `origin`, `operation_type`, `icms_cst` e `csosn` carregam ZEROS À
    // ESQUERDA que uma leitura numérica destruiria em silêncio.
    const lido = shopeeItemBaseInfoSchema.parse(
      corpoItemBase({}, { tax_info: { origin: '0', csosn: '0102', icms_cst: '000', pis: '1.65' } }),
    );
    const tax = lido.response.item_list[0]!.tax_info!;
    expect(tax.origin).toBe('0');
    expect(tax.origin).not.toBe(0);
    expect(tax.csosn).toBe('0102');
    expect(tax.icms_cst).toBe('000');
    expect(tax.pis).toBe('1.65');
    for (const valor of [tax.origin, tax.csosn, tax.icms_cst, tax.pis]) {
      expect(typeof valor).toBe('string');
    }
  });

  it('14 — `price_info` ausente (item COM models) parseia como `null`', () => {
    const lido = shopeeItemBaseInfoSchema.parse(corpoItemBase({}, { has_model: true }));
    expect(lido.response.item_list[0]!.has_model).toBe(true);
    expect(lido.response.item_list[0]!.price_info).toBeNull();
  });

  it('15 — `wholesales` (PLURAL) é o nome lido, e o campo interno é `unit_price`', () => {
    // ⚠️ Só o CONTÊINER muda entre leitura e escrita (`wholesales` → `wholesale`).
    // Renomear o campo interno para `unit` corromperia o valor.
    const lido = shopeeItemBaseInfoSchema.parse(
      corpoItemBase({}, { wholesales: [{ min_count: 2, max_count: 5, unit_price: 19.9 }] }),
    );
    const faixa = lido.response.item_list[0]!.wholesales![0]!;
    expect(faixa.unit_price).toBe(19.9);
    expect(faixa.min_count).toBe(2);
    expect(faixa.max_count).toBe(5);
    // ⚠️ `\b` antes de `unit:`, senão `measure_unit:` (do bloco fiscal) casaria.
    expect(CODIGO_PASSO_9).toMatch(/unit_price:/);
    expect(CODIGO_PASSO_9).not.toMatch(/\bunit:/);
  });

  it('16 — `item_status: "SELLER_DELETE"` parseia: o enum estrito é do lado do REQUEST', () => {
    const lido = shopeeItemBaseInfoSchema.parse(
      corpoItemBase({}, { item_status: 'SELLER_DELETE' }),
    );
    expect(lido.response.item_list[0]!.item_status).toBe('SELLER_DELETE');
  });

  it('17 — um `item_status` que a Shopee inventar amanhã NÃO derruba a página', () => {
    // ⚠️ Esse conjunto já andou uma vez (quatro valores → seis). Um enum estrito
    // na RESPOSTA derrubaria a página inteira — e com ela a varredura inteira.
    const paginado = shopeeItemListSchema.parse(
      corpoItemList({ item: [{ item_id: ITEM_ID, item_status: 'ALGO_QUE_NAO_EXISTE_HOJE' }] }),
    );
    expect(paginado.response.item[0]!.item_status).toBe('ALGO_QUE_NAO_EXISTE_HOJE');
  });

  it('18 — get_model_list com as DUAS árvores presentes', () => {
    const lido = shopeeModelListSchema.parse(
      corpoModelList({
        tier_variation: [{ name: 'Cor', option_list: [{ option: 'Azul' }] }],
        standardise_tier_variation: [
          { variation_id: 100_043, variation_name: 'Cor', variation_option_list: [] },
        ],
        model: [{ model_id: MODEL_ID, tier_index: [0] }],
      }),
    );
    expect(lido.response.tier_variation![0]!.option_list[0]!.option).toBe('Azul');
    expect(lido.response.standardise_tier_variation![0]!.variation_id).toBe(100_043);
    expect(lido.response.model[0]!.model_id).toBe(MODEL_ID);
  });

  it('19 — get_model_list com SÓ `tier_variation`', () => {
    const lido = shopeeModelListSchema.parse(
      corpoModelList({ tier_variation: [{ name: 'Tamanho', option_list: [{ option: 'M' }] }] }),
    );
    expect(lido.response.tier_variation).toHaveLength(1);
    expect(lido.response.standardise_tier_variation).toBeNull();
  });

  it('20 — get_model_list com SÓ `standardise_tier_variation`', () => {
    const lido = shopeeModelListSchema.parse(
      corpoModelList({
        standardise_tier_variation: [
          { variation_id: 0, variation_name: 'Cor', variation_option_list: [] },
        ],
      }),
    );
    expect(lido.response.standardise_tier_variation).toHaveLength(1);
    expect(lido.response.tier_variation).toBeNull();
  });

  it('21 — get_model_list com NENHUMA das duas árvores: `model[]` ainda parseia', () => {
    // ⚠️ O legado desreferenciava `tier_variation!` enquanto o próprio
    // exportador dele chamava essa árvore de depreciada. Toda combinação tem de
    // atravessar: a identidade da opção cai de volta no NOME.
    const lido = shopeeModelListSchema.parse(
      corpoModelList({ model: [{ model_id: MODEL_ID, model_sku: 'SKU-AZUL-M' }] }),
    );
    expect(lido.response.tier_variation).toBeNull();
    expect(lido.response.standardise_tier_variation).toBeNull();
    expect(lido.response.model[0]!.model_sku).toBe('SKU-AZUL-M');
  });

  it('22 — `variation_id: 0` e `variation_option_id: 0` sobrevivem como ZERO', () => {
    // ⚠️ `0` é a SENTINELA documentada de opção CUSTOM — um valor, não uma
    // ausência — e para uma loja BR fora de Moda todo id aqui é 0.
    const lido = shopeeModelListSchema.parse(
      corpoModelList({
        standardise_tier_variation: [
          {
            variation_id: 0,
            variation_name: 'Cor',
            variation_option_list: [{ variation_option_id: 0, variation_option_name: 'Azul' }],
          },
        ],
      }),
    );
    const arvore = lido.response.standardise_tier_variation![0]!;
    expect(arvore.variation_id).toBe(0);
    expect(arvore.variation_id).not.toBeNull();
    expect(arvore.variation_option_list[0]!.variation_option_id).toBe(0);
  });

  it('23 — `promotion_id` é lido como número e o tipo o expõe — nenhum consumidor o grava', () => {
    // ⚠️ É um uint64 desde 2026-07-31. Acima de 2^53 o valor já chega corrompido
    // do `JSON.parse`, e `.int()` aceitaria o resultado. Por isso ele é LIDO e
    // descartado, nunca armazenado.
    const lido = shopeeModelListSchema.parse(
      corpoModelList({ model: [{ model_id: MODEL_ID, promotion_id: '104993304719361' }] }),
    );
    expect(lido.response.model[0]!.promotion_id).toBe(104_993_304_719_361);
  });

  it('24 — `shopee_stock[].stock` como STRING e como INT dão o mesmo número', () => {
    // ⚠️ A Shopee tipa esse campo como int32 numa página e como string na outra.
    // Uma tolerância, duas páginas.
    const comoString = shopeeModelListSchema.parse(
      corpoModelList({
        model: [
          {
            model_id: MODEL_ID,
            stock_info_v2: { shopee_stock: [{ location_id: 'BR', stock: '7' }] },
          },
        ],
      }),
    ).response.model[0]!.stock_info_v2!.shopee_stock![0]!.stock;

    const comoInt = shopeeItemBaseInfoSchema.parse(
      corpoItemBase({}, { stock_info_v2: { shopee_stock: [{ location_id: 'BR', stock: 7 }] } }),
    ).response.item_list[0]!.stock_info_v2!.shopee_stock![0]!.stock;

    expect(comoString).toBe(7);
    expect(comoString).toBe(comoInt);
  });

  it('25 — get_kit_item_info: `category_id` ESCALAR e `category_id` ARRAY, ambos parseiam', () => {
    // ⚠️ A página declara `int64[]` e o sample dela devolve um escalar.
    expect(
      shopeeKitItemInfoSchema.parse(corpoKit({ category_id: 107_290 })).response.product_info
        ?.category_id,
    ).toBe(107_290);
    expect(
      shopeeKitItemInfoSchema.parse(corpoKit({ category_id: [107_290] })).response.product_info
        ?.category_id,
    ).toEqual([107_290]);
  });

  it('26 — get_kit_item_info: `image` (sample) e `images` (tabela) coexistem', () => {
    const lido = shopeeKitItemInfoSchema.parse(
      corpoKit({
        images: { image_id_list: ['a'], image_url_list: ['https://cf.shopee.com.br/file/a'] },
        image: { image_id_list: ['b'], image_url_list: ['https://cf.shopee.com.br/file/b'] },
      }),
    );
    expect(lido.response.product_info?.images?.image_id_list).toEqual(['a']);
    expect(lido.response.product_info?.image?.image_id_list).toEqual(['b']);
  });

  it('27 — get_kit_item_info: `model_sku: ""` (STRING) parseia apesar do int64 declarado', () => {
    // ⚠️ Um sku é identidade: ler `"001"` como o número 1 dobraria dois skus
    // diferentes num só.
    const lido = shopeeKitItemInfoSchema.parse(
      corpoKit({ model_list: [{ model_id: MODEL_ID, model_sku: '' }] }),
    );
    expect(lido.response.product_info?.model_list[0]!.model_sku).toBe('');
  });

  it('28 — get_kit_item_info: `tier_variation_list[].option_list[].image` OBJETO ou ARRAY', () => {
    const comoObjeto = shopeeKitItemInfoSchema.parse(
      corpoKit({
        tier_variation_list: [
          { name: 'Cor', option_list: [{ option: 'Azul', image: { image_id: 'a' } }] },
        ],
      }),
    );
    const comoArray = shopeeKitItemInfoSchema.parse(
      corpoKit({
        tier_variation_list: [
          { name: 'Cor', option_list: [{ option: 'Azul', image: [{ image_id: 'a' }] }] },
        ],
      }),
    );
    expect(
      comoObjeto.response.product_info?.tier_variation_list![0]!.option_list[0]!.image,
    ).toEqual({ image_id: 'a', image_url: null });
    expect(comoArray.response.product_info?.tier_variation_list![0]!.option_list[0]!.image).toEqual(
      [{ image_id: 'a', image_url: null }],
    );
  });

  it('29 — ⛔ NEAR-MISS: `product_info` ausente vira `null` — quem recusa o kit é a app, não a página', () => {
    expect(shopeeKitItemInfoSchema.parse(corpoKit(null)).response.product_info).toBeNull();
    expect(
      shopeeKitItemInfoSchema.parse({ error: '', response: {} }).response.product_info,
    ).toBeNull();
  });

  it('30 — nenhum schema novo do passo 9 declara um `z.number()` CRU', () => {
    // ⚠️ O mesmo invariante que `integration-response-numbers-tolerant.test.js`
    // guarda no repo, aplicado ao trecho deste passo: um serializador que cita
    // UM campo não pode custar o recurso inteiro (#1087).
    const cruas = CODIGO_PASSO_9.split('\n').filter((linha) => /z\.number\(\)/.test(linha));
    expect(cruas).toEqual([]);
    // ÂNCORA: o trecho realmente foi encontrado e tem números nele.
    expect(CODIGO_PASSO_9.length).toBeGreaterThan(1000);
    expect(CODIGO_PASSO_9).toContain('wireInt()');
    expect(CODIGO_PASSO_9).toContain('wireNumber()');
  });

  it('53 — ⛔ NEAR-MISS: nenhum schema novo declara `promotion_id` em get_item_base_info', () => {
    // ⚠️ Removido dessa página em 2026-04-03; sobrevive só no sample obsoleto
    // dela. Declará-lo convidaria a uma leitura de um campo que não chega mais.
    const baseInfo = trechoEntre('get_item_base_info ---', 'get_model_list ---');
    expect(baseInfo).not.toContain('promotion_id');

    // ÂNCORA, e é ela que impede o teste de passar lendo o trecho errado: o
    // `get_model_list` DECLARA o campo, porque lá ele existe.
    expect(trechoEntre('get_model_list ---', 'get_kit_item_info ---')).toContain('promotion_id');

    // E um corpo que ainda o traga atravessa pelo passthrough, sem ser tipado.
    const lido = shopeeItemBaseInfoSchema.parse(corpoItemBase({}, { promotion_id: 123 }));
    expect((lido.response.item_list[0] as unknown as Record<string, unknown>).promotion_id).toBe(
      123,
    );
  });
});

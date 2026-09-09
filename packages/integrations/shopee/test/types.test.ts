import { describe, expect, it } from 'vitest';

import {
  SHOPEE_INVOICE_ISSUER,
  SHOPEE_SHOP_STATUS,
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
  shopeeFaixaSchema,
  shopeeItemLimitSchema,
  shopeeKitItemLimitSchema,
  shopeeLostPushSchema,
  shopeeOrderDetailSchema,
  shopeeOrderListSchema,
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

  it('os ~100 campos que o passo 6 vai ler atravessam pelo passthrough', () => {
    const parsed = shopeeEscrowDetailSchema.parse(
      corpoEscrow({ commission_fee: 3.5, service_fee: 1, order_adjustment: [{ amount: 10.1 }] }),
    );
    const income = parsed.response.order_income as unknown as Record<string, unknown>;
    expect(income.commission_fee).toBe(3.5);
    expect(income.service_fee).toBe(1);
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

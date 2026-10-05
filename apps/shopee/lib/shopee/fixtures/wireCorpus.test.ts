import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  shopeeEscrowDetailSchema,
  shopeeOrderDetailSchema,
  shopeeSearchPackageListSchema,
} from '@delfrance/integrations-shopee';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_ESCROW_DETAIL_DOC_KIT,
  FIXTURE_ESCROW_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_DOC_MASKED_VN,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED,
  FIXTURE_SEARCH_PACKAGE_LIST_DOC,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_INVOICE_PENDING_TRUE,
  WIRE_DIR,
  lerBuscaDePacotes,
  lerEscrowDetalhe,
  lerFixture,
  lerPedidoDetalhe,
  listarFixtures,
} from './wireCorpus';

describe('o inventário do corpus', () => {
  it('é exatamente o conjunto de corpos que este passo promoveu', () => {
    // ⚠️ Conjunto EXATO, não um piso: "nunca adicione um arquivo à mão" só vale
    // se adicionar um quebrar algo. O escrow do pedido de sandbox CHEGOU
    // (2026-09-10), e este teste, os loaders e a tabela do README mudaram no
    // MESMO commit — que é a revisão que uma fixture nova precisa ter. O passo
    // 15b fez o mesmo com os quatro corpos de `search_package_list`.
    expect(listarFixtures()).toEqual([
      FIXTURE_ESCROW_DETAIL_DOC_KIT,
      FIXTURE_ESCROW_DETAIL_QTY2_SG,
      FIXTURE_ORDER_DETAIL_DOC_MASKED_VN,
      FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED,
      FIXTURE_ORDER_DETAIL_QTY2_SG,
      FIXTURE_SEARCH_PACKAGE_LIST_DOC,
      FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA,
      FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO,
      FIXTURE_SEARCH_PACKAGE_LIST_SG_INVOICE_PENDING_TRUE,
    ]);
  });

  it('traz um README que separa o que a Shopee MANDOU do que a doc IMPRIME', () => {
    const readme = readFileSync(join(WIRE_DIR, 'README.md'), 'utf8');
    expect(readme).toContain(FIXTURE_ORDER_DETAIL_QTY2_SG);
    expect(readme).toContain(FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED);
    expect(readme).toContain(FIXTURE_ORDER_DETAIL_DOC_MASKED_VN);
    expect(readme).toContain(FIXTURE_ESCROW_DETAIL_DOC_KIT);
    expect(readme).toContain(FIXTURE_ESCROW_DETAIL_QTY2_SG);
    expect(readme).toContain(FIXTURE_SEARCH_PACKAGE_LIST_DOC);
    expect(readme).toContain(FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA);
    expect(readme).toContain(FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO);
    expect(readme).toContain(FIXTURE_SEARCH_PACKAGE_LIST_SG_INVOICE_PENDING_TRUE);
    expect(readme).toContain('unverified for BR');
    // ⚠️ E a âncora do sentido inverso: o slot vazio ACABOU, então a frase que o
    // anunciava não pode sobreviver ao corpo que o preencheu.
    expect(readme).not.toContain('pending from Lucas');
  });
});

describe('o pedido de sandbox SG (o corpo que a Shopee mandou)', () => {
  const pagina = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG);
  const pedido = pagina.response.order_list[0]!;

  it('parseia pelo schema do pacote, inteiro', () => {
    expect(pagina.response.order_list).toHaveLength(1);
    expect(pedido.order_sn).toBe('260910KJBHUJDM');
    expect(pedido.order_status).toBe('READY_TO_SHIP');
    expect(pedido.region).toBe('SG');
  });

  it('prova que o preço do DETALHE é POR UNIDADE: 15 × 2 + 1,99 = 31,99', () => {
    // ⚠️ O fato que fecha o item 1 do registro de "resolver ao vivo". Quantidade
    // 1 não distinguiria as duas leituras — é por isso que este pedido precisava
    // ter quantidade 2.
    const item = pedido.item_list![0]!;
    expect(item.model_discounted_price).toBe(15);
    expect(item.model_quantity_purchased).toBe(2);
    expect(pedido.estimated_shipping_fee).toBe(1.99);
    expect(pedido.total_amount).toBe(31.99);
    expect(item.model_discounted_price! * item.model_quantity_purchased! + 1.99).toBe(
      pedido.total_amount,
    );
  });

  it('traz product_location_id como ARRAY no item e como STRING no pacote, na MESMA resposta', () => {
    expect(pedido.item_list![0]!.product_location_id).toEqual(['SGZ']);
    expect(pedido.package_list![0]!.item_list![0]!.product_location_id).toBe('SGZ');
  });

  it('a chave de peso que chega é parcel_chargeable_weight_gram, e a da tabela NÃO vem', () => {
    const pacote = pedido.package_list![0]!;
    expect(pacote.parcel_chargeable_weight_gram).toBe(0);
    expect(pacote.parcel_chargeable_weight).toBeNull();
  });

  it('ZERA os numéricos ausentes — um `??` neles é um bug, só `> 0` distingue', () => {
    // ⚠️ O comprador PAGOU 1,99 de frete e `actual_shipping_fee` veio 0.
    expect(pedido.actual_shipping_fee).toBe(0);
    expect(pedido.estimated_shipping_fee).toBe(1.99);
    expect(pedido.edt_from).toBe(0);
    expect(pedido.edt_to).toBe(0);
    expect(pedido.pickup_done_time).toBe(0);
    expect(pedido.order_chargeable_weight_gram).toBe(0);
    // ... e o prazo REAL da Shopee veio preenchido, acima do piso de 2020.
    expect(pedido.ship_by_date).toBe(1_789_405_354);
    expect(pedido.ship_by_date!).toBeGreaterThan(1_577_836_800);
  });

  it('num pedido não-BR, invoice_data / payment_info / buyer_cpf_id são NULL', () => {
    expect(pedido.invoice_data).toBeNull();
    expect(pedido.payment_info).toBeNull();
    expect(pedido.buyer_cpf_id).toBeNull();
  });

  it('order_item_id é IGUAL a item_id — ele não é uma identidade por linha', () => {
    // ⚠️ É o que derruba `mktplaceId = String(order_item_id)`: neste corpo ele
    // não distingue nada.
    const item = pedido.item_list![0]!;
    expect(item.order_item_id).toBe(item.item_id);
    expect(item.line_item_id).not.toBe(item.item_id);
  });

  it('a máscara é POR CAMPO: name/phone mascarados ao lado de campos limpos', () => {
    const endereco = pedido.recipient_address!;
    expect(endereco.name).toBe('****');
    expect(endereco.phone).toBe('****');
    // Os grosseiros vêm VAZIOS por região — vazio não é máscara.
    expect(endereco.town).toBe('');
    expect(endereco.city).toBe('');
    expect(endereco.state).toBe('');
    expect(endereco.region).toBe('SG');
  });
});

/* -------------------------------------------------------------------------- */

describe('o escrow do MESMO pedido de sandbox (o corpo que fechou o item 1 e o 6)', () => {
  const escrow = lerEscrowDetalhe(FIXTURE_ESCROW_DETAIL_QTY2_SG).response;
  const linha = escrow.order_income!.items![0]!;
  const detalhe = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;

  it('parseia INTEIRO pelo schema do pacote — ao contrário do exemplo da doc', () => {
    // ⚠️ O contraste é o ponto: o exemplo da doc é RECUSADO num caminho (os ids
    // `0.1` do kit) e este corpo real passa por completo. Um schema que
    // recusasse os dois seria indistinguível de um schema quebrado.
    expect(() =>
      shopeeEscrowDetailSchema.parse(lerFixture(FIXTURE_ESCROW_DETAIL_QTY2_SG)),
    ).not.toThrow();
    expect(escrow.order_sn).toBe('260910KJBHUJDM');
    expect(escrow.order_income!.items).toHaveLength(1);
  });

  it('⚠️ o dinheiro POR ITEM do escrow é o TOTAL DA LINHA; o do detalhe é POR UNIDADE', () => {
    // O fato do fio que fecha o item 1 do registro. `discounted_price` 30 com
    // `quantity_purchased` 2, enquanto o MESMO pedido no `get_order_detail` diz
    // `model_discounted_price` 15 — exatamente o que a frase "subtotal if
    // quantity exceeds 1" das nove colunas do escrow promete. É por isso que
    // `precoUnitario` divide o escrow e NÃO divide o detalhe.
    expect(linha.discounted_price).toBe(30);
    expect(linha.original_price).toBe(30);
    expect(linha.selling_price).toBe(30);
    expect(linha.quantity_purchased).toBe(2);
    const unitarioDoEscrow = linha.discounted_price! / linha.quantity_purchased!;
    expect(unitarioDoEscrow).toBe(15);
    expect(unitarioDoEscrow).toBe(detalhe.item_list![0]!.model_discounted_price);
    // NEAR-MISS: as duas leituras NÃO coincidem por acaso — a quantidade é 2,
    // que é a única quantidade capaz de distingui-las.
    expect(linha.discounted_price).not.toBe(detalhe.item_list![0]!.model_discounted_price);
  });

  it('buyer_total_amount 31,99 = buyer_paid_shipping_fee 1,99 + order_discounted_price 30', () => {
    // É a PRIMEIRA rampa de `valorCobradoDoPedido`, e este corpo diz que ela
    // responde o mesmo que o `total_amount` do detalhe.
    // ⚠️ Pelos campos DECLARADOS do schema, não por um cast: os três estão em
    // `shopeeOrderIncomeSchema`, e ler pelo tipo é o que faz este teste cair se
    // algum deles sair da declaração.
    const renda = escrow.order_income!;
    expect(renda.buyer_total_amount).toBe(31.99);
    expect(renda.buyer_paid_shipping_fee).toBe(1.99);
    expect(renda.order_discounted_price).toBe(30);
    expect(renda.buyer_paid_shipping_fee! + renda.order_discounted_price!).toBe(
      renda.buyer_total_amount,
    );
    expect(renda.buyer_total_amount).toBe(detalhe.total_amount);
  });

  it('num pedido NÃO-BR a linha do escrow não traz is_kit nem kit_items — e os dois leem null', () => {
    // ⚠️ AUSENTES, não `null` no fio: as chaves simplesmente não estão no corpo.
    // Quem responde `null` é o `.nullable().default(null)` do schema, e é o que
    // `ehKitShopee` lê como "desconhecido", nunca como "não é kit".
    const cru = lerFixture(FIXTURE_ESCROW_DETAIL_QTY2_SG) as {
      response: { order_income: { items: Record<string, unknown>[] } };
    };
    const linhaCrua = cru.response.order_income.items[0]!;
    expect('is_kit' in linhaCrua).toBe(false);
    expect('kit_items' in linhaCrua).toBe(false);
    expect(linha.is_kit).toBeNull();
    expect(linha.kit_items).toBeNull();
  });

  it('ZERA os numéricos ausentes aqui também, e guarda os números da etapa 6', () => {
    expect(escrow.order_income!.actual_shipping_fee).toBe(0);
    expect(escrow.order_income!.escrow_amount).toBe(30.7);
    // ⚠️ Estas quatro NÃO estão declaradas: chegam pelo `.passthrough()` de
    // `shopeeOrderIncomeSchema`, porque são material da ETAPA 6 (tarifas e
    // repasse) e nada da etapa 5 as lê. Ficam gravadas aqui porque só um corpo
    // real diz quais destas ~100 colunas chegam preenchidas.
    const passthrough = escrow.order_income! as unknown as Record<string, number | undefined>;
    expect(passthrough.order_chargeable_weight).toBe(0);
    expect(passthrough.commission_fee).toBe(0.65);
    expect(passthrough.credit_card_transaction_fee).toBe(0.64);
    expect(passthrough.seller_transaction_fee).toBe(0.64);
  });

  it('o buyer_user_name — a OUTRA grafia — saiu redigido do corpo commitado', () => {
    // ⚠️ `get_escrow_detail` escreve `buyer_user_name` e `get_order_detail`
    // escreve `buyer_username`; as duas estão no denylist e esta é a primeira
    // fixture em que a grafia do escrow aparece de verdade.
    expect(escrow.buyer_user_name).toBe('REDACTED');
  });
});

/* -------------------------------------------------------------------------- */

describe('o MESMO pedido depois do arrange-shipment (PROCESSED)', () => {
  const pagina = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED);
  const depois = pagina.response.order_list[0]!;
  const antes = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;

  it('parseia pelo schema do pacote e é o MESMO pedido', () => {
    expect(() =>
      shopeeOrderDetailSchema.parse(lerFixture(FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED)),
    ).not.toThrow();
    expect(depois.order_sn).toBe(antes.order_sn);
  });

  it('o que MUDA: order_status, logistics_status e update_time', () => {
    expect(depois.order_status).toBe('PROCESSED');
    expect(depois.package_list![0]!.logistics_status).toBe('LOGISTICS_REQUEST_CREATED');
    expect(depois.update_time).toBe(1_789_042_568);
    expect(depois.update_time!).toBeGreaterThan(antes.update_time!);
    // ⚠️ `PROCESSED` mapeia para `pago` na escada — o mesmo degrau de
    // `READY_TO_SHIP`, então esta transição não move o estado do pedido; o que
    // ela move é o watermark.
    expect(antes.order_status).toBe('READY_TO_SHIP');
  });

  it('note e note_update_time VOLTAM — os dois tokens novos do response_optional_fields', () => {
    // ⚠️ Um campo opcional não nomeado chega AUSENTE, não vazio: a captura de
    // 2026-09-09 não os pedia e o corpo não os trazia. Aqui eles vêm, vazios e
    // zerados, que é o que um pedido sem anotação do vendedor responde.
    expect(depois.note).toBe('');
    expect(depois.note_update_time).toBe(0);
    expect(antes.note).toBeNull();
  });

  it('⚠️ o que NÃO muda: o destinatário segue mascarado e o frete real segue zerado', () => {
    // Item 5 do registro CONTINUA aberto: sem whitelist na sandbox, "mascarado"
    // e "sem permissão de desmascarar" são indistinguíveis — e um pedido que
    // avançou de status sem desmascarar é consistente com as duas leituras.
    expect(depois.recipient_address!.name).toBe('****');
    expect(depois.recipient_address!.phone).toBe('****');
    // …e o zero-fill sobrevive à mudança de status: o frete REAL só é conhecido
    // depois da coleta, então `??` continua sendo um bug aqui.
    expect(depois.actual_shipping_fee).toBe(0);
    expect(depois.estimated_shipping_fee).toBe(1.99);
    expect(depois.pickup_done_time).toBe(0);
    expect(depois.total_amount).toBe(31.99);
  });
});

describe('o exemplo da doc (VN, endereço mascarado)', () => {
  const pedido = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_DOC_MASKED_VN).response.order_list[0]!;

  it('parseia, e guarda a OUTRA grafia de máscara — estrela parcial, não `****`', () => {
    // ⚠️ Não verificado para o BR: é um pedido VN. As duas grafias juntas são o
    // que a regra "nenhum `*` em lugar nenhum" tem de cobrir.
    expect(pedido.recipient_address!.name).toBe('P******n');
    expect(pedido.recipient_address!.phone).toBe('******64');
    expect(pedido.recipient_address!.name).toMatch(/\*/);
    expect(pedido.recipient_address!.name).not.toBe('****');
  });

  it('carrega um COMPLETED, e o `note`/`message_to_seller` VAZIOS do exemplo seguem vazios', () => {
    // ⚠️ Os dois estão no denylist, mas o exemplo os traz em branco — e a redação
    // mantém o vazio, porque "vazio" e "redigido" não podem virar a mesma coisa.
    expect(pedido.order_status).toBe('COMPLETED');
    expect(pedido.message_to_seller).toBe('');
  });
});

describe('o exemplo da doc do escrow', () => {
  it('carrega is_kit com kit_items no formato OBJETO singular', () => {
    const corpo = lerFixture(FIXTURE_ESCROW_DETAIL_DOC_KIT) as {
      response: { order_income: { items: { is_kit: boolean; kit_items: unknown }[] } };
    };
    const item = corpo.response.order_income.items[0]!;
    expect(item.is_kit).toBe(true);
    expect(Array.isArray(item.kit_items)).toBe(false);
    expect(item.kit_items).not.toBeNull();
    // ⚠️ A forma ARRAY continua NÃO verificada: a página não mostra um kit de
    // vários componentes. O schema aceita as duas; só uma tem evidência.
  });

  it('é RECUSADO pelo schema em exatamente UM caminho — os ids 0,1 do exemplo', () => {
    // ⚠️ Deliberado, e é o motivo de `wireInt()` nesses campos: a página usa
    // `0.1` como valor de preenchimento para todo float, e arredondar um id é
    // inventar um id. O corpo inteiro — ~200 campos — passa; só o kit não.
    const resultado = shopeeEscrowDetailSchema.safeParse(lerFixture(FIXTURE_ESCROW_DETAIL_DOC_KIT));
    expect(resultado.success).toBe(false);
    expect(resultado.error!.issues.map((i) => i.path.join('.'))).toEqual([
      'response.order_income.items.0.kit_items',
    ]);
  });

  it('guarda o `error: " "` do exemplo VERBATIM — é a esquisitice da página, não uma licença', () => {
    // `shopeeCall` só aceita `''` como sucesso e esta operação não tem alias
    // nenhum, então um espaço aqui SERIA falha no fio. A fixture registra o que a
    // página imprime; o `api.test.ts` do pacote prende que isso é uma falha.
    const corpo = lerFixture(FIXTURE_ESCROW_DETAIL_DOC_KIT) as { error: string };
    expect(corpo.error).toBe(' ');
  });
});

/* -------------------------------------------------------------------------- */
/*            A busca de pacotes (passo 15b): o exemplo da doc + o SG          */
/* -------------------------------------------------------------------------- */

/** Os quatro corpos de `search_package_list`, na ordem do inventário. */
const CORPOS_BUSCA = [
  FIXTURE_SEARCH_PACKAGE_LIST_DOC,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_INVOICE_PENDING_TRUE,
] as const;

/** O corpo CRU de `search_package_list`, para as asserções que o schema esconde. */
interface BuscaCrua {
  message?: unknown;
  mesage?: unknown;
  request_id?: unknown;
  response: {
    packages_list: Record<string, unknown>[] | null;
    pagination?: unknown;
    sort?: Record<string, unknown>;
  };
}

function lerBuscaCrua(file: string): BuscaCrua {
  return lerFixture(file) as unknown as BuscaCrua;
}

describe('a busca de pacotes — os quatro corpos, pelo schema do pacote', () => {
  it.each(CORPOS_BUSCA)('%s parseia INTEIRO — nenhuma linha virou a sentinela `null`', (file) => {
    // ⚠️ `lerBuscaDePacotes` lançar não basta: uma linha ilegível PARSEIA como
    // `null`. Um corpo commitado que perdesse linhas em silêncio passaria num
    // "não lança" e este teste existe para dizer o contrário.
    expect(() => shopeeSearchPackageListSchema.parse(lerFixture(file))).not.toThrow();
    const pagina = lerBuscaDePacotes(file).response;
    expect(pagina.packages_list.filter((linha) => linha === null)).toEqual([]);
    expect(pagina.packages_list).toHaveLength(lerBuscaCrua(file).response.packages_list!.length);
    // E todo corpo — a doc E os três do SG — traz a `pagination`.
    expect(pagina.pagination).not.toBeNull();
  });

  it.each(CORPOS_BUSCA)(
    '%s carrega `message` — a grafia `mesage` da TABELA não aparece',
    (file) => {
      const cru = lerBuscaCrua(file);
      expect(cru.message).toBe('');
      expect('mesage' in cru).toBe(false);
      // `request_id` saiu antes do commit, em todos.
      expect('request_id' in cru).toBe(false);
    },
  );
});

describe('o exemplo da doc de search_package_list (VN)', () => {
  const pagina = lerBuscaDePacotes(FIXTURE_SEARCH_PACKAGE_LIST_DOC).response;

  it('uma linha não arranjada, num canal VN — ⚠️ não verificado para o BR', () => {
    expect(pagina.packages_list).toHaveLength(1);
    const linha = pagina.packages_list[0]!;
    expect(linha.is_shipment_arranged).toBe(false);
    expect(linha.logistics_channel_id).toBe(50021);
  });

  it('`more: true` com o cursor COMPOSTO, verbatim — é o único corpo que mostra uma página 2', () => {
    expect(pagina.pagination?.more).toBe(true);
    expect(pagina.pagination?.next_cursor).toMatch(/^\d+,\d+$/);
    expect(pagina.pagination?.total_count).toBe(320);
  });

  it('o eco do `sort` da doc diz `is_asc` — o que o fio SG NÃO manda', () => {
    const sort = lerBuscaCrua(FIXTURE_SEARCH_PACKAGE_LIST_DOC).response.sort!;
    expect(Object.keys(sort).sort()).toEqual(['is_asc', 'sort_type']);
  });
});

describe('o SG sandbox — os três corpos que a Shopee MANDOU (2026-10-01)', () => {
  it('nos canais DA LOJA: UMA linha, o pedido do passo 14, ainda NÃO arranjado', () => {
    const pagina = lerBuscaDePacotes(FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA).response;
    expect(pagina.packages_list).toHaveLength(1);
    const linha = pagina.packages_list[0]!;
    // ⚠️ Ids de FIXTURE, gravados pela sonda no lugar dos do fio: o `order_sn`
    // coincide com o dos corpos de `get_order_detail` por CONVENÇÃO, não porque
    // seja o mesmo pedido — aquele está `PROCESSED` desde 2026-09-10.
    expect(linha.order_sn).toBe('260910KJBHUJDM');
    expect(linha.package_number).toBe('OFG000000000001');
    expect(linha.package_number).not.toBe(
      lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!.package_list![0]!
        .package_number,
    );
    expect(linha.is_shipment_arranged).toBe(false);
    expect(linha.logistics_channel_id).toBe(11006);
    // Drenada: `more: false` E `next_cursor: ""` — quem termina o laço é o
    // `more`; o cursor vazio é só o que vem junto.
    expect(pagina.pagination).toEqual({ total_count: 1, more: false, next_cursor: '' });
  });

  it('as chaves da linha no fio são EXATAMENTE as seis da página, e `product_location_id` é STRING', () => {
    const cru = lerBuscaCrua(FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA);
    const linha = cru.response.packages_list![0]!;
    expect(Object.keys(linha).sort()).toEqual([
      'is_shipment_arranged',
      'logistics_channel_id',
      'order_sn',
      'package_number',
      'product_location_id',
      'sorting_group',
    ]);
    expect(typeof linha.product_location_id).toBe('string');
  });

  it('⚠️ o eco do `sort` no fio é `{sort_type, ascending}` — a chave do PEDIDO, não o `is_asc` da doc', () => {
    // QUASE-IGUAL com o exemplo da doc logo acima: mesma operação, mesma
    // posição, outra chave. É por isso que o `sort` da resposta não é declarado.
    for (const file of [
      FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA,
      FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO,
      FIXTURE_SEARCH_PACKAGE_LIST_SG_INVOICE_PENDING_TRUE,
    ]) {
      expect(lerBuscaCrua(file).response.sort, file).toEqual({ sort_type: 1, ascending: true });
    }
  });

  it.each([
    FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO,
    FIXTURE_SEARCH_PACKAGE_LIST_SG_INVOICE_PENDING_TRUE,
  ])('a resposta VAZIA (%s) é `packages_list: []` COM `pagination` — registro 223', (file) => {
    // ⚠️ Um ARRAY vazio, nunca `null` nem ausente — e a `pagination` vem
    // inteira. O schema tolera os dois ausentes; o fio não os manda.
    const cru = lerBuscaCrua(file);
    expect(Array.isArray(cru.response.packages_list)).toBe(true);
    expect(cru.response.packages_list).toEqual([]);
    expect(cru.response.pagination).toEqual({ total_count: 0, more: false, next_cursor: '' });

    const pagina = lerBuscaDePacotes(file).response;
    expect(pagina.packages_list).toEqual([]);
    expect(pagina.pagination).toEqual({ total_count: 0, more: false, next_cursor: '' });
  });

  it('o filtro de canal é aplicado no SERVIDOR — registro 224', () => {
    // A loja TEM um pacote pronto (o corpo dos canais da loja); pedido nos
    // canais Turbo, que a loja SG não tem, ele some. Nenhuma linha fora do
    // filtro chegou para o chamador descartar.
    const daLoja = lerBuscaDePacotes(FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA).response;
    const turbo = lerBuscaDePacotes(FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO).response;
    expect(daLoja.packages_list.map((l) => l?.package_number)).toEqual(['OFG000000000001']);
    expect(turbo.packages_list.map((l) => l?.package_number)).not.toContain('OFG000000000001');
  });

  it('`invoice_pending: true` FILTRA: o pacote não pendente sai — mas o `false` segue sem leitura (registro 222)', () => {
    // ⚠️ Prova só METADE: sem pacote pendente no SG, "false = só não pendentes"
    // e "false = sem filtro" respondem igual. O registro 222 é BR-only, e quem
    // o fecha é o contador `nfePendenteNaBusca` da varredura.
    const pendentes = lerBuscaDePacotes(FIXTURE_SEARCH_PACKAGE_LIST_SG_INVOICE_PENDING_TRUE);
    expect(pendentes.response.packages_list).toEqual([]);
    const daLoja = lerBuscaDePacotes(FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA);
    expect(daLoja.response.packages_list).toHaveLength(1);
  });
});

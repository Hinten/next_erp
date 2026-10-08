import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SHOPEE_ERROR_KIND,
  SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
  SHOPEE_GET_ITEM_BASE_INFO_PATH,
  SHOPEE_GET_ITEM_LIST_PATH,
  SHOPEE_GET_KIT_ITEM_INFO_PATH,
  SHOPEE_GET_KIT_ITEM_LIMIT_PATH,
  SHOPEE_GET_MODEL_LIST_PATH,
  SHOPEE_GET_RETURN_DETAIL_PATH,
  SHOPEE_GET_RETURN_LIST_PATH,
  SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
  SHOPEE_GET_SIZE_CHART_LIST_PATH,
  SHOPEE_ITEM_STATUS_WIRE,
  SHOPEE_RETURN_ACCEPT_OFFER_PATH,
  SHOPEE_RETURN_CONFIRM_PATH,
  SHOPEE_RETURN_OFFER_PATH,
  SHOPEE_RETURN_SOLUTION,
  ShopeeApiError,
  type ShopeeClient,
  ShopeeOperacaoNaoServidaError,
  createShopeeClient,
  lerPaginaDeTabelasDeMedidas,
  resolveShopeeHosts,
  shopeeEscrowDetailSchema,
  shopeeOrderDetailSchema,
  shopeeReturnAvailableSolutionsSchema,
  shopeeReturnWriteSchema,
  shopeeSearchPackageListSchema,
  shopeeSizeChartDetailSchema,
  shopeeSizeChartListSchema,
} from '@delfrance/integrations-shopee';
import { SHOPEE_SIZE_CHART_INPUT_TYPE, ehReturnSnShopee } from '@delfrance/schemas';
import { describe, expect, it, vi } from 'vitest';

import {
  CATEGORIA_DOC_DO_KIT,
  CORPOS_KIT_LEITURA,
  FIXTURE_ESCROW_DETAIL_DOC_KIT,
  FIXTURE_ESCROW_DETAIL_QTY2_SG,
  FIXTURE_ITEM_BASE_INFO_SG_KIT,
  FIXTURE_ITEM_LIST_SG_COM_KIT,
  FIXTURE_ITEM_LIST_SG_SELLER_DELETE,
  FIXTURE_KIT_ITEM_INFO_SG_APAGADO,
  FIXTURE_KIT_ITEM_INFO_SG_NAO_KIT,
  FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO,
  FIXTURE_KIT_ITEM_LIMIT_SG_HTTP404,
  FIXTURE_MODEL_LIST_SG_ITEM_SEM_VARIACAO,
  FIXTURE_MODEL_LIST_SG_KIT,
  IDS_APAGADOS_SEM_PAPEL,
  IDS_DO_KIT_NO_CORPUS,
  IMAGEM_DOC_DO_KIT,
  RELOGIO_SONDA_KIT_1_S,
  FIXTURE_ORDER_DETAIL_DOC_MASKED_VN,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED,
  FIXTURE_RETURN_ACCEPT_OFFER_DOC,
  FIXTURE_RETURN_AVAILABLE_SOLUTIONS_DOC,
  FIXTURE_RETURN_CONFIRM_DOC,
  FIXTURE_RETURN_DETAIL_DOC,
  FIXTURE_RETURN_LIST_DOC,
  FIXTURE_RETURN_OFFER_DOC,
  FIXTURE_SEARCH_PACKAGE_LIST_DOC,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_INVOICE_PENDING_TRUE,
  FIXTURE_SIZE_CHART_DETAIL_DOC,
  FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE,
  FIXTURE_SIZE_CHART_LIST_DOC,
  FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA,
  WIRE_DIR,
  lerBaseDosItens,
  lerBuscaDePacotes,
  lerDetalheDeTabelaDeMedidas,
  lerDevolucaoDetalhe,
  lerEscrowDetalhe,
  lerFixture,
  lerKitDoCorpus,
  lerListaDeDevolucoes,
  lerListaDeItens,
  lerListaDeModelos,
  lerListaDeTabelasDeMedidas,
  lerPedidoDetalhe,
  listarFixtures,
} from './wireCorpus';

/** The six returns bodies (step 17), in the inventory's order. */
const CORPOS_DEVOLUCAO = [
  FIXTURE_RETURN_ACCEPT_OFFER_DOC,
  FIXTURE_RETURN_CONFIRM_DOC,
  FIXTURE_RETURN_AVAILABLE_SOLUTIONS_DOC,
  FIXTURE_RETURN_DETAIL_DOC,
  FIXTURE_RETURN_LIST_DOC,
  FIXTURE_RETURN_OFFER_DOC,
] as const;

/** The four size-chart bodies (step 18), in the inventory's order. */
const CORPOS_TABELA_DE_MEDIDAS = [
  FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE,
  FIXTURE_SIZE_CHART_DETAIL_DOC,
  FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA,
  FIXTURE_SIZE_CHART_LIST_DOC,
] as const;

/** Os dezenove corpos de ANTES do passo 19, na ordem do inventário. */
const CORPOS_ANTES_DO_PASSO_19 = [
  FIXTURE_RETURN_ACCEPT_OFFER_DOC,
  FIXTURE_RETURN_CONFIRM_DOC,
  FIXTURE_RETURN_AVAILABLE_SOLUTIONS_DOC,
  FIXTURE_ESCROW_DETAIL_DOC_KIT,
  FIXTURE_ESCROW_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_DOC_MASKED_VN,
  FIXTURE_ORDER_DETAIL_QTY2_SG_PROCESSED,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  FIXTURE_RETURN_DETAIL_DOC,
  FIXTURE_RETURN_LIST_DOC,
  FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE,
  FIXTURE_SIZE_CHART_DETAIL_DOC,
  FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA,
  FIXTURE_SIZE_CHART_LIST_DOC,
  FIXTURE_RETURN_OFFER_DOC,
  FIXTURE_SEARCH_PACKAGE_LIST_DOC,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_DA_LOJA,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_CANAIS_TURBO,
  FIXTURE_SEARCH_PACKAGE_LIST_SG_INVOICE_PENDING_TRUE,
] as const;

/** Os corpos dos kits nativos (passo 19): o conjunto de leitura (PR 3). */
const CORPOS_KIT = [...CORPOS_KIT_LEITURA] as const;

describe('o inventário do corpus', () => {
  it('é exatamente o conjunto de corpos que este passo promoveu', () => {
    // ⚠️ Conjunto EXATO, não um piso: "nunca adicione um arquivo à mão" só vale
    // se adicionar um quebrar algo. O escrow do pedido de sandbox CHEGOU
    // (2026-09-10), e este teste, os loaders e a tabela do README mudaram no
    // MESMO commit — que é a revisão que uma fixture nova precisa ter. O passo
    // 15b fez o mesmo com os quatro corpos de `search_package_list`, o 17 com
    // os seis das devoluções, o 18 com os quatro das tabelas de medidas e o 19
    // com os nove de leitura dos kits nativos.
    // ⚠️ `get_size_chart_detail.doc-id-inexistente` ordena ANTES de
    // `get_size_chart_detail.doc`: `-` (0x2D) < `.` (0x2E).
    expect(listarFixtures().filter((f) => !CORPOS_KIT.includes(f as never))).toEqual([
      ...CORPOS_ANTES_DO_PASSO_19,
    ]);
    expect(listarFixtures()).toEqual([...CORPOS_ANTES_DO_PASSO_19, ...CORPOS_KIT].sort());
  });

  it('a lista de leitura do kit está ORDENADA', () => {
    // A constante diz "sorted" no docblock; um arquivo novo enfiado
    // fora de ordem passaria no inventário acima (que ordena) e mentiria aqui.
    expect([...CORPOS_KIT_LEITURA]).toEqual([...CORPOS_KIT_LEITURA].sort());
    expect(CORPOS_KIT_LEITURA).toHaveLength(9);
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
    for (const file of CORPOS_DEVOLUCAO) expect(readme, file).toContain(`\`${file}\``);
    for (const file of CORPOS_TABELA_DE_MEDIDAS) expect(readme, file).toContain(`\`${file}\``);
    for (const file of CORPOS_KIT) expect(readme, file).toContain(`\`${file}\``);
    expect(readme).toContain('unverified for BR');
    // A contagem da prosa anda com o inventário: um corpo novo sem a frase
    // corrigida deixaria o README mentindo sobre o próprio diretório.
    expect(listarFixtures()).toHaveLength(28);
    expect(readme).toContain('Twenty-eight bodies today');
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

/* -------------------------------------------------------------------------- */
/*        As devoluções (passo 17, #1525): os seis exemplos da doc            */
/* -------------------------------------------------------------------------- */

/** O `error` que CADA página imprime no exemplo de sucesso — nenhum é `''`. */
const ERRO_DA_PAGINA: Readonly<Record<(typeof CORPOS_DEVOLUCAO)[number], string>> = {
  [FIXTURE_RETURN_ACCEPT_OFFER_DOC]: ' ',
  [FIXTURE_RETURN_CONFIRM_DOC]: ' ',
  [FIXTURE_RETURN_AVAILABLE_SOLUTIONS_DOC]: ' ',
  [FIXTURE_RETURN_DETAIL_DOC]: '-',
  [FIXTURE_RETURN_LIST_DOC]: '-',
  [FIXTURE_RETURN_OFFER_DOC]: ' ',
};

/** O `return_sn` de FIXTURE que cada corpo carrega no lugar do da página. */
const RETURN_SN_DO_CORPO: Readonly<Record<(typeof CORPOS_DEVOLUCAO)[number], string>> = {
  [FIXTURE_RETURN_ACCEPT_OFFER_DOC]: '2609100000000002',
  [FIXTURE_RETURN_CONFIRM_DOC]: '2609100000000001',
  [FIXTURE_RETURN_AVAILABLE_SOLUTIONS_DOC]: '2609100000000002',
  [FIXTURE_RETURN_DETAIL_DOC]: '260910ABCDE0001',
  [FIXTURE_RETURN_LIST_DOC]: '2609100000000001',
  [FIXTURE_RETURN_OFFER_DOC]: '2609100000000002',
};

/**
 * As chaves de COMPRADOR que as duas páginas de leitura carregam (redigidas no
 * arquivo). Nenhuma pode sobreviver ao parse do pacote — o schema delas é um
 * `z.object` que DESCARTA o que não declara (#1525 R-11).
 */
const CHAVES_DO_COMPRADOR = [
  'user',
  'username',
  'email',
  'portrait',
  'return_pickup_address',
  'address',
  'phone',
  'image',
  'images',
  'buyer_videos',
  'text_reason',
  'dispute_text_reason',
  'tracking_number',
  'virtual_contact_number',
  'package_query_number',
  'latest_offer_creator',
  'name',
] as const;

/** Toda chave, em qualquer profundidade — a caminhada do T-PII-1. */
function todasAsChaves(v: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) {
    for (const x of v) todasAsChaves(x, acc);
  } else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      acc.add(k);
      todasAsChaves(x, acc);
    }
  }
  return acc;
}

/** O corpo CRU de uma devolução, para as asserções que o schema esconde. */
interface DevolucaoCrua {
  error?: unknown;
  message?: unknown;
  request_id?: unknown;
  response: Record<string, unknown>;
}

function lerDevolucaoCrua(file: string): DevolucaoCrua {
  return lerFixture(file) as unknown as DevolucaoCrua;
}

describe('as devoluções — os seis corpos crus (exemplos da doc, ❌ não verificados para o BR)', () => {
  it.each(CORPOS_DEVOLUCAO)(
    '%s guarda o `error` da PÁGINA verbatim, e saiu sem `request_id`',
    (file) => {
      // ⚠️ Nenhum é `''`: é exatamente por isso que as seis operações carregam
      // `SHOPEE_RETURNS_ERROR_ALIASES`, e é este byte que o teste do cliente,
      // abaixo, faz passar pelo transporte de verdade.
      const cru = lerDevolucaoCrua(file);
      expect(cru.error).toBe(ERRO_DA_PAGINA[file]);
      expect(cru.error).not.toBe('');
      expect(cru.message).toBe(ERRO_DA_PAGINA[file]);
      expect('request_id' in cru).toBe(false);
    },
  );

  it.each(CORPOS_DEVOLUCAO)(
    '%s carrega um return_sn de FIXTURE que o predicado único aceita',
    (file) => {
      const rsn = lerDevolucaoCrua(file).response;
      const valor =
        file === FIXTURE_RETURN_LIST_DOC
          ? (rsn.return as Record<string, unknown>[])[0]!.return_sn
          : rsn.return_sn;
      expect(valor).toBe(RETURN_SN_DO_CORPO[file]);
      expect(ehReturnSnShopee(valor)).toBe(true);
    },
  );

  it('⚠️ o do DETALHE é ALFANUMÉRICO, como o exemplo da página — um guard só de dígitos o recusaria', () => {
    const rsn = lerDevolucaoCrua(FIXTURE_RETURN_DETAIL_DOC).response.return_sn as string;
    expect(rsn).toMatch(/[A-Z]/);
    expect(rsn).not.toMatch(/^\d+$/);
  });

  it('o detalhe carrega as TRÊS grafias em que a página contradiz a própria tabela', () => {
    const r = lerDevolucaoCrua(FIXTURE_RETURN_DETAIL_DOC).response;
    // `reverse_logistic_status` sem `s` — a tabela tem `s` (registro 241).
    expect(r.reverse_logistic_status).toBe('LOGISTICS_REQUEST_CREATED');
    expect('reverse_logistics_status' in r).toBe(false);
    // `dispute_reason` NÚMERO — a tabela diz `string[]`.
    expect(r.dispute_reason).toBe(2);
    // `dispute_text_reason` STRING (redigida) — a tabela diz `string[]`.
    expect(r.dispute_text_reason).toBe('REDACTED');
    // …e o `seller_compensation_status` SEM prefixo (registro 240), mais o
    // `original_price` do `activity` ENTRE ASPAS.
    expect((r.seller_compensation as Record<string, unknown>).seller_compensation_status).toBe(
      'PENDING_REQUEST',
    );
    expect(
      ((r.activity as Record<string, unknown>[])[0]!.items as Record<string, unknown>[])[0]!
        .original_price,
    ).toBe('12.34');
  });

  it('os blocos do comprador CHEGARAM ao arquivo — e saíram redigidos, máscara incluída', () => {
    // Âncora do sentido inverso do T-PII abaixo: as chaves EXISTEM no corpo cru,
    // então "o parse não as tem" é uma frase sobre o STRIP, não sobre o arquivo.
    const detalhe = lerDevolucaoCrua(FIXTURE_RETURN_DETAIL_DOC).response;
    expect(detalhe.user).toEqual({ username: 'REDACTED', email: 'REDACTED', portrait: 'REDACTED' });
    expect((detalhe.return_pickup_address as Record<string, unknown>).name).toBe('REDACTED');
    expect(detalhe.tracking_number).toBe('REDACTED');
    expect(detalhe.text_reason).toBe('REDACTED');
    const linha = (
      lerDevolucaoCrua(FIXTURE_RETURN_LIST_DOC).response.return as Record<string, unknown>[]
    )[0]!;
    expect((linha.user as Record<string, unknown>).email).toBe('REDACTED');
    expect(linha.dispute_text_reason).toEqual(['REDACTED']);
  });
});

describe('as devoluções pelo schema do pacote', () => {
  it('o detalhe parseia INTEIRO, e o que o importador lê está lá', () => {
    const env = lerDevolucaoDetalhe(FIXTURE_RETURN_DETAIL_DOC);
    const d = env.response;
    expect(env.error).toBe('-');
    expect(d.return_sn).toBe('260910ABCDE0001');
    expect(d.order_sn).toBe('260910KJBHUJDM');
    expect(d.status).toBe('ACCEPTED');
    expect(d.update_time).toBe(1_655_219_544);
    expect(d.create_time).toBe(1_655_205_084);
    expect(d.refund_amount).toBe(13.97);
    expect(d.due_date).toBe(1_655_377_883);
    expect(d.return_seller_due_date).toBe(1_655_438_205);
    expect(d.return_solution).toBe(0);
    expect(d.return_refund_request_type).toBe(0);
    expect(d.validation_type).toBe('seller_validation');
    expect(d.is_seller_arrange).toBe(true);
    // ⚠️ A grafia SEM `s` do exemplo chega como a da TABELA (registro 241).
    expect(d.reverse_logistics_status).toBe('LOGISTICS_REQUEST_CREATED');
    expect(d.seller_proof?.seller_proof_status).toBe('PENDING');
    expect(d.seller_compensation?.seller_compensation_status).toBe('PENDING_REQUEST');
    expect(d.negotiation?.negotiation_status).toBe('PENDING_RESPOND');
    expect(d.negotiation?.latest_solution).toBe('RETURN_REFUND');
    expect(d.negotiation?.offer_due_date).toBe(1_655_438_336);
  });

  it('a lista parseia INTEIRA — nenhuma linha virou a sentinela `null`', () => {
    const env = lerListaDeDevolucoes(FIXTURE_RETURN_LIST_DOC);
    expect(env.error).toBe('-');
    expect(env.response.more).toBe(true);
    expect(env.response.return).toHaveLength(1);
    const linha = env.response.return[0]!;
    expect(linha).not.toBeNull();
    expect(linha.return_sn).toBe('2609100000000001');
    expect(linha.status).toBe('CANCELLED');
    expect(linha.update_time).toBe(1_580_729_377);
    expect(linha.refund_amount).toBe(1409);
    // Os três sub-status vêm PLANOS na lista.
    expect(linha.negotiation_status).toBe('PENDING_RESPOND');
    expect(linha.seller_proof_status).toBe('PENDING');
    expect(linha.seller_compensation_status).toBe('PENDING_REQUEST');
  });

  it.each([FIXTURE_RETURN_DETAIL_DOC, FIXTURE_RETURN_LIST_DOC])(
    '⚠️ T-PII sobre o CORPUS (%s): nenhuma chave nem valor redigido sobrevive ao parse',
    (file) => {
      const parseado =
        file === FIXTURE_RETURN_DETAIL_DOC ? lerDevolucaoDetalhe(file) : lerListaDeDevolucoes(file);
      const chaves = todasAsChaves(parseado);
      expect(CHAVES_DO_COMPRADOR.filter((k) => chaves.has(k))).toEqual([]);
      // O gêmeo por VALOR: toda folha que a redação tocou é uma chave que o
      // schema não declara — então nenhum `REDACTED` chega à saída. Um campo de
      // comprador declarado por engano reapareceria aqui com o placeholder.
      expect(JSON.stringify(parseado)).not.toContain('REDACTED');
      // …e o cru TEM as chaves: a ausência acima é obra do strip.
      expect(todasAsChaves(lerFixture(file)).has('user')).toBe(true);
    },
  );

  it('as soluções disponíveis: as duas ofertas com mínimo e máximo, e o `15.0` da página no byte', () => {
    const r = shopeeReturnAvailableSolutionsSchema.parse(
      lerFixture(FIXTURE_RETURN_AVAILABLE_SOLUTIONS_DOC),
    ).response;
    expect(r.return_sn).toBe('2609100000000002');
    expect(r.offer_return_refund).toMatchObject({
      eligibility: true,
      refund_amount_adjustable: true,
      max_refund_amount: 15,
      min_refund_amount: 5,
    });
    expect(r.offer_refund).toMatchObject({
      eligibility: true,
      refund_amount_adjustable: true,
      max_refund_amount: 10,
      min_refund_amount: 5,
    });
    // Os literais FLOAT da página ficaram como ela os imprime.
    const texto = readFileSync(join(WIRE_DIR, FIXTURE_RETURN_AVAILABLE_SOLUTIONS_DOC), 'utf8');
    expect(texto).toContain('"max_refund_amount": 15.0');
    expect(texto).toContain('"min_refund_amount": 5.0');
  });

  it.each([
    FIXTURE_RETURN_CONFIRM_DOC,
    FIXTURE_RETURN_OFFER_DOC,
    FIXTURE_RETURN_ACCEPT_OFFER_DOC,
  ] as const)(
    '%s: `{return_sn}` sob um `response` PRESENTE — a metade "response presente" do alias',
    (file) => {
      const env = shopeeReturnWriteSchema.parse(lerFixture(file));
      expect(env.error).toBe(' ');
      expect(env.response.return_sn).toBe(RETURN_SN_DO_CORPO[file]);
      expect(env.response.msg).toBeNull();
    },
  );
});

/**
 * Um cliente REAL do pacote cujo `fetch` responde o TEXTO do arquivo commitado —
 * nunca uma cópia à mão: é o corpus que carrega a evidência do alias.
 */
function clienteDoCorpus(file: string): {
  readonly client: ShopeeClient;
  readonly caminhos: string[];
} {
  const texto = readFileSync(join(WIRE_DIR, file), 'utf8');
  const caminhos: string[] = [];
  const transporte = vi.fn<typeof globalThis.fetch>((entrada) => {
    const url =
      typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    caminhos.push(new URL(url).pathname);
    return Promise.resolve(
      new Response(texto, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
  const client = createShopeeClient({
    partnerId: 1000001,
    partnerKey: 'chave-de-teste-nao-e-credencial',
    hosts: resolveShopeeHosts({ sandbox: true }),
    fetch: transporte,
    shopId: 987654,
    getAccessToken: () => Promise.resolve('access-inventado'),
  });
  return { client, caminhos };
}

/** [arquivo, caminho, chamada, o parse que o cliente tem de devolver INTEIRO]. */
const CHAMADAS_DE_DEVOLUCAO: readonly (readonly [
  (typeof CORPOS_DEVOLUCAO)[number],
  string,
  (c: ShopeeClient) => Promise<unknown>,
  (corpo: unknown) => unknown,
])[] = [
  [
    FIXTURE_RETURN_LIST_DOC,
    SHOPEE_GET_RETURN_LIST_PATH,
    (c) => c.getReturnList({ pageNo: 0, pageSize: 10 }),
    () => lerListaDeDevolucoes(FIXTURE_RETURN_LIST_DOC),
  ],
  [
    FIXTURE_RETURN_DETAIL_DOC,
    SHOPEE_GET_RETURN_DETAIL_PATH,
    (c) => c.getReturnDetail({ returnSn: '260910ABCDE0001' }),
    () => lerDevolucaoDetalhe(FIXTURE_RETURN_DETAIL_DOC),
  ],
  [
    FIXTURE_RETURN_AVAILABLE_SOLUTIONS_DOC,
    SHOPEE_GET_AVAILABLE_SOLUTIONS_PATH,
    (c) => c.getReturnAvailableSolutions({ returnSn: '2609100000000002' }),
    (corpo) => shopeeReturnAvailableSolutionsSchema.parse(corpo),
  ],
  [
    FIXTURE_RETURN_CONFIRM_DOC,
    SHOPEE_RETURN_CONFIRM_PATH,
    (c) => c.confirmReturn({ returnSn: '2609100000000001' }),
    (corpo) => shopeeReturnWriteSchema.parse(corpo),
  ],
  [
    FIXTURE_RETURN_OFFER_DOC,
    SHOPEE_RETURN_OFFER_PATH,
    (c) =>
      c.offerReturn({
        returnSn: '2609100000000002',
        proposedSolution: SHOPEE_RETURN_SOLUTION.soReembolso,
      }),
    (corpo) => shopeeReturnWriteSchema.parse(corpo),
  ],
  [
    FIXTURE_RETURN_ACCEPT_OFFER_DOC,
    SHOPEE_RETURN_ACCEPT_OFFER_PATH,
    (c) => c.acceptReturnOffer({ returnSn: '2609100000000002' }),
    (corpo) => shopeeReturnWriteSchema.parse(corpo),
  ],
];

describe('as devoluções pelo CLIENTE do pacote, com o corpo commitado no fio', () => {
  it('cobre as seis operações, uma vez cada', () => {
    // Âncora anti-vacuidade do `it.each` abaixo.
    expect(CHAMADAS_DE_DEVOLUCAO.map(([file]) => file).sort()).toEqual(
      [...CORPOS_DEVOLUCAO].sort(),
    );
  });

  it.each(CHAMADAS_DE_DEVOLUCAO)(
    '%s RESOLVE pelo transporte de verdade — só porque a operação carrega o alias',
    async (file, caminho, chamar, parse) => {
      // ⚠️ O `error` deste corpo é `"-"` ou `" "`, e `shopeeCall` só aceita `''`
      // como sucesso sem alias: tirar `SHOPEE_RETURNS_ERROR_ALIASES` de qualquer
      // uma das seis faz ESTA linha rejeitar com `ShopeeApiError`.
      const { client, caminhos } = clienteDoCorpus(file);
      const resposta = await chamar(client);
      expect(caminhos).toEqual([caminho]);
      // O envelope INTEIRO (R-17), não só `response`: o `error` da página volta
      // como VALOR — é o instrumento do registro 231.
      expect(resposta).toEqual(parse(lerFixture(file)));
      expect((resposta as { error: unknown }).error).toBe(ERRO_DA_PAGINA[file]);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*     As tabelas de medidas (passo 18, #1526): os quatro exemplos da doc     */
/* -------------------------------------------------------------------------- */

/** O corpo CRU de uma página de tabela de medidas, para o que o schema esconde. */
type TabelaCrua = Record<string, unknown>;

function lerTabelaCrua(file: string): TabelaCrua {
  return lerFixture(file) as unknown as TabelaCrua;
}

/** Os dois exemplos de ERRO, cada um com a frase que a SUA página imprime. */
const FRASE_DO_ERRO = {
  [FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA]: 'Category id is invalid',
  [FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE]: 'Size chart id not exist in this shop',
} as const;

/** Uma célula do detalhe já parseada: as quatro chaves, `null` onde o exemplo não preenche. */
function celula(preenchida: {
  option?: string;
  value?: number;
  min_value?: number;
  max_value?: number;
}): Record<string, unknown> {
  return { option: null, value: null, min_value: null, max_value: null, ...preenchida };
}

describe('as tabelas de medidas — os quatro corpos crus (exemplos da doc, ❌ não verificados para o BR)', () => {
  it('cobre os quatro corpos do passo 18, um de cada', () => {
    // Âncora anti-vacuidade dos `it.each` abaixo: cada um percorre uma METADE.
    expect(
      [
        FIXTURE_SIZE_CHART_LIST_DOC,
        FIXTURE_SIZE_CHART_DETAIL_DOC,
        ...Object.keys(FRASE_DO_ERRO),
      ].sort(),
    ).toEqual([...CORPOS_TABELA_DE_MEDIDAS].sort());
  });

  it.each([FIXTURE_SIZE_CHART_LIST_DOC, FIXTURE_SIZE_CHART_DETAIL_DOC])(
    '%s: as chaves da PÁGINA menos `request_id`, com `error`/`message`/`warning` vazios',
    (file) => {
      // ⚠️ Ao contrário das devoluções, o sucesso destas páginas é `''`: nenhum
      // alias de erro vazio é preciso aqui.
      const cru = lerTabelaCrua(file);
      expect(Object.keys(cru).sort()).toEqual(['error', 'message', 'response', 'warning']);
      expect(cru.error).toBe('');
      expect(cru.message).toBe('');
      expect(cru.warning).toBe('');
    },
  );

  it.each([
    FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA,
    FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE,
  ] as const)(
    '%s: o exemplo de ERRO é só `{error, message}` — sem `response`, sem `request_id`',
    (file) => {
      const cru = lerTabelaCrua(file);
      expect(Object.keys(cru).sort()).toEqual(['error', 'message']);
      expect(cru.error).toBe('product.error_param');
      expect(cru.message).toBe(FRASE_DO_ERRO[file]);
    },
  );

  it('⚠️ UM código, DUAS frases — só a frase separa a tabela velha da categoria recusada (registro 258)', () => {
    const inexistente = lerTabelaCrua(FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE);
    const categoria = lerTabelaCrua(FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA);
    // IGUAL: o código não distingue nada…
    expect(inexistente.error).toBe(categoria.error);
    // …QUASE-IGUAL: a frase é a única diferença entre os dois corpos.
    expect(inexistente.message).not.toBe(categoria.message);
  });

  it('a lista traz ids e `total_count` como NÚMEROS JSON — a tabela da página diz `string` (registro 248)', () => {
    const resposta = lerTabelaCrua(FIXTURE_SIZE_CHART_LIST_DOC).response as {
      size_chart_list: Record<string, unknown>[];
      total_count: unknown;
      next_cursor: unknown;
    };
    expect(resposta.size_chart_list.map((linha) => typeof linha.size_chart_id)).toEqual([
      'number',
      'number',
      'number',
    ]);
    expect(typeof resposta.total_count).toBe('number');
    // A página drenada responde `""`; um `null` ou a chave ausente é o registro 249.
    expect(resposta.next_cursor).toBe('');
    // E a linha é SÓ o id: a lista não traz nome nenhum — o nome custa um detalhe.
    for (const linha of resposta.size_chart_list) {
      expect(Object.keys(linha)).toEqual(['size_chart_id']);
    }
  });

  it('o detalhe: cada célula traz as QUATRO chaves, nulas exceto as que o `input_type` da coluna nomeia', () => {
    // ⚠️ É o que a regra "tipo primeiro" do projetor lê. Um exemplo que obedece
    // não é garantia — o fio zera numéricos ausentes em outras páginas (registro
    // 254) —, e por isso o projetor nunca lê a chave que o tipo não nomeia.
    const chavesDoTipo: Readonly<Record<string, readonly string[]>> = {
      [SHOPEE_SIZE_CHART_INPUT_TYPE.numero]: ['value'],
      [SHOPEE_SIZE_CHART_INPUT_TYPE.faixa]: ['max_value', 'min_value'],
      [SHOPEE_SIZE_CHART_INPUT_TYPE.opcao]: ['option'],
    };
    const resposta = lerTabelaCrua(FIXTURE_SIZE_CHART_DETAIL_DOC).response as {
      size_chart_table: {
        column_list: {
          measurement: { input_type: string };
          measurement_value_list: Record<string, unknown>[];
        }[];
      };
    };
    const colunas = resposta.size_chart_table.column_list;
    expect(colunas).toHaveLength(3);
    for (const coluna of colunas) {
      const esperadas = chavesDoTipo[coluna.measurement.input_type];
      expect(esperadas, coluna.measurement.input_type).toBeDefined();
      expect(coluna.measurement_value_list).toHaveLength(3);
      for (const c of coluna.measurement_value_list) {
        expect(Object.keys(c).sort()).toEqual(['max_value', 'min_value', 'option', 'value']);
        expect(Object.keys(c).filter((k) => c[k] !== null)).toEqual(esperadas);
      }
    }
  });
});

describe('as tabelas de medidas pelo schema do pacote', () => {
  it('a lista parseia INTEIRA — nenhuma linha virou a sentinela `null`', () => {
    const pagina = lerListaDeTabelasDeMedidas(FIXTURE_SIZE_CHART_LIST_DOC);
    expect(pagina.size_chart_list).toEqual([
      { size_chart_id: 700024641 },
      { size_chart_id: 700024613 },
      { size_chart_id: 700024605 },
    ]);
    expect(pagina.total_count).toBe(3);
    expect(pagina.next_cursor).toBe('');
  });

  it('o leitor de página do pacote a lê como a ÚLTIMA página: `fim`, três ids, nenhuma ilegível', () => {
    expect(
      lerPaginaDeTabelasDeMedidas(lerListaDeTabelasDeMedidas(FIXTURE_SIZE_CHART_LIST_DOC)),
    ).toEqual({
      ids: [700024641, 700024613, 700024605],
      linhasIlegiveis: 0,
      total: 3,
      continuacao: { estado: 'fim' },
    });
  });

  it('o detalhe parseia INTEIRO — 3 colunas × 3 células, nenhuma sentinela `null`, os três tipos da página', () => {
    const detalhe = lerDetalheDeTabelaDeMedidas(FIXTURE_SIZE_CHART_DETAIL_DOC);
    expect(detalhe.size_chart_id).toBe(700024639);
    expect(detalhe.size_chart_name).toBe('testtestt');
    const colunas = detalhe.size_chart_table?.column_list ?? [];
    expect(colunas.filter((coluna) => coluna === null)).toEqual([]);
    // ⚠️ As três grafias do corpus SÃO as do constante único — um "conserto" na
    // grafia de `SHOPEE_SIZE_CHART_INPUT_TYPE` cai aqui, contra a evidência.
    // E `unit: 'cm'` está também na coluna de LISTA (o "01s cm" do registro).
    expect(colunas.map((coluna) => coluna?.measurement)).toEqual([
      {
        display_name: 'test single input number',
        input_type: SHOPEE_SIZE_CHART_INPUT_TYPE.numero,
        unit: 'cm',
      },
      {
        display_name: 'susu_input_range_number_with_special_unit_kg',
        input_type: SHOPEE_SIZE_CHART_INPUT_TYPE.faixa,
        unit: 'kg',
      },
      {
        display_name: 'regional 001 dropdowm',
        input_type: SHOPEE_SIZE_CHART_INPUT_TYPE.opcao,
        unit: 'cm',
      },
    ]);
    expect(colunas.map((coluna) => coluna?.measurement_value_list)).toEqual([
      [celula({ value: 1 }), celula({ value: 2 }), celula({ value: 3 })],
      [
        celula({ min_value: 12, max_value: 13 }),
        celula({ min_value: 13, max_value: 14 }),
        celula({ min_value: 14, max_value: 16 }),
      ],
      [celula({ option: '01s' }), celula({ option: '01m' }), celula({ option: '01l' })],
    ]);
  });

  it('⚠️ os dois exemplos são tabelas DIFERENTES: o eco do detalhe não é id nenhum da lista', () => {
    // Nunca junte dois corpos por id: um id da lista pedido a ESTE detalhe é um
    // id que o eco contradiz — o `id-divergente` do projetor, não um 3×3 limpo.
    const ids = lerPaginaDeTabelasDeMedidas(
      lerListaDeTabelasDeMedidas(FIXTURE_SIZE_CHART_LIST_DOC),
    ).ids;
    const eco = lerDetalheDeTabelaDeMedidas(FIXTURE_SIZE_CHART_DETAIL_DOC).size_chart_id;
    expect(eco).toBe(700024639);
    expect(ids).not.toContain(eco);
    // QUASE-IGUAL: o primeiro id da lista é o eco + 2 — vizinho não é o mesmo id.
    expect(ids[0]).toBe(700024639 + 2);
  });

  it.each([
    [FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA, shopeeSizeChartListSchema],
    [FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE, shopeeSizeChartDetailSchema],
  ] as const)(
    '%s NÃO parseia pelo schema da operação — falta só `response`; leia-o com `lerFixture`',
    (file, schema) => {
      const resultado = schema.safeParse(lerFixture(file));
      expect(resultado.success).toBe(false);
      expect(resultado.error!.issues.map((i) => i.path.join('.'))).toEqual(['response']);
    },
  );

  it('os loaders LANÇAM num corpo de erro — nunca devolvem uma página vazia', () => {
    expect(() =>
      lerListaDeTabelasDeMedidas(FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA),
    ).toThrow();
    expect(() =>
      lerDetalheDeTabelaDeMedidas(FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE),
    ).toThrow();
  });
});

/**
 * Um cliente REAL do pacote cujo `fetch` responde o TEXTO do arquivo commitado,
 * registrando o método e o caminho de cada chamada.
 */
function clienteDaTabelaDeMedidas(file: string): {
  readonly client: ShopeeClient;
  readonly chamadas: { readonly metodo: string | undefined; readonly caminho: string }[];
} {
  const texto = readFileSync(join(WIRE_DIR, file), 'utf8');
  const chamadas: { metodo: string | undefined; caminho: string }[] = [];
  const transporte = vi.fn<typeof globalThis.fetch>((entrada, init) => {
    const url =
      typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    chamadas.push({ metodo: init?.method, caminho: new URL(url).pathname });
    return Promise.resolve(
      new Response(texto, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  });
  const client = createShopeeClient({
    partnerId: 1000001,
    partnerKey: 'chave-de-teste-nao-e-credencial',
    hosts: resolveShopeeHosts({ sandbox: true }),
    fetch: transporte,
    shopId: 987654,
    getAccessToken: () => Promise.resolve('access-inventado'),
  });
  return { client, chamadas };
}

describe('as tabelas de medidas pelo CLIENTE do pacote, com o corpo commitado no fio', () => {
  it.each([
    [
      FIXTURE_SIZE_CHART_LIST_DOC,
      SHOPEE_GET_SIZE_CHART_LIST_PATH,
      (c: ShopeeClient): Promise<unknown> =>
        c.getSizeChartList({ categoryId: 400055, pageSize: 50 }),
      (): unknown => lerListaDeTabelasDeMedidas(FIXTURE_SIZE_CHART_LIST_DOC),
    ],
    [
      FIXTURE_SIZE_CHART_DETAIL_DOC,
      SHOPEE_GET_SIZE_CHART_DETAIL_PATH,
      (c: ShopeeClient): Promise<unknown> => c.getSizeChartDetail({ sizeChartId: 700024639 }),
      (): unknown => lerDetalheDeTabelaDeMedidas(FIXTURE_SIZE_CHART_DETAIL_DOC),
    ],
  ] as const)(
    '%s RESOLVE num GET, e o que o cliente devolve é o que o loader devolve',
    async (file, caminho, chamar, carregar) => {
      // É o contrato do loader: o PAYLOAD, como a operação o devolve — então um
      // cliente falso pode repassá-lo sem tirar nem pôr.
      const { client, chamadas } = clienteDaTabelaDeMedidas(file);
      await expect(chamar(client)).resolves.toEqual(carregar());
      expect(chamadas).toEqual([{ metodo: 'GET', caminho }]);
    },
  );

  it.each([
    [
      FIXTURE_SIZE_CHART_LIST_DOC_CATEGORIA_INVALIDA,
      (c: ShopeeClient): Promise<unknown> =>
        c.getSizeChartList({ categoryId: 400055, pageSize: 50 }),
    ],
    [
      FIXTURE_SIZE_CHART_DETAIL_DOC_ID_INEXISTENTE,
      (c: ShopeeClient): Promise<unknown> => c.getSizeChartDetail({ sizeChartId: 700024641 }),
    ],
  ] as const)(
    '%s REJEITA com o `ShopeeApiError` que o classificador lê: o código, `kind: other` e a frase VERBATIM',
    async (file, chamar) => {
      const { client } = clienteDaTabelaDeMedidas(file);
      const promessa = chamar(client);
      await expect(promessa).rejects.toBeInstanceOf(ShopeeApiError);
      await expect(promessa).rejects.toMatchObject({
        code: 'product.error_param',
        kind: SHOPEE_ERROR_KIND.other,
        providerMessage: FRASE_DO_ERRO[file],
      });
    },
  );
});

/* -------------------------------------------------------------------------- */
/*     Os kits nativos (passo 19, #1527): as capturas das duas sondas SG       */
/* -------------------------------------------------------------------------- */

const {
  kit: KIT,
  modeloDoKit: KIT_M1,
  componenteA: A,
  modeloDoComponenteA: A_W02,
  componenteB: B,
  modeloOcultoDoComponenteB: B_OCULTO,
} = IDS_DO_KIT_NO_CORPUS;

/** O TEXTO commitado de um corpo — para o que só os bytes dizem. */
function textoDoCorpo(file: string): string {
  return readFileSync(join(WIRE_DIR, file), 'utf8');
}

/** Toda string de um corpo, em qualquer profundidade. */
function todasAsStrings(v: unknown, acc: string[] = []): string[] {
  if (typeof v === 'string') acc.push(v);
  else if (Array.isArray(v)) for (const x of v) todasAsStrings(x, acc);
  else if (v !== null && typeof v === 'object')
    for (const x of Object.values(v)) todasAsStrings(x, acc);
  return acc;
}

/**
 * Todo número de 7+ dígitos que um corpo do kit pode carregar: um PAPEL do README,
 * um relógio de sonda — ou os dígitos da imagem da doc, que não são um número.
 */
const NUMEROS_COM_PAPEL: ReadonlySet<string> = new Set(
  [...Object.values(IDS_DO_KIT_NO_CORPUS), ...IDS_APAGADOS_SEM_PAPEL, RELOGIO_SONDA_KIT_1_S].map(
    String,
  ),
);

describe('os kits nativos — ids por PAPEL, nunca o `1000001` achatado das sondas (M47)', () => {
  it.each(CORPOS_KIT)('%s não guarda o `1000001` que a máscara da sonda escreveu', (file) => {
    // ⚠️ M47: um id achatado é IMPOSSÍVEL de juntar e ambíguo com o partner de
    // fixture (`1000001`). A promoção trocou cada um pelo seu papel.
    expect(textoDoCorpo(file)).not.toContain('1000001');
  });

  it.each(CORPOS_KIT)(
    '%s: todo número de 7+ dígitos é um PAPEL do README — nenhum id real sobrou',
    (file) => {
      const corridas = [...textoDoCorpo(file).matchAll(/\d{7,}/g)].map(([d]) => d);
      expect(
        corridas.filter((d) => !NUMEROS_COM_PAPEL.has(d) && !IMAGEM_DOC_DO_KIT.includes(d)),
      ).toEqual([]);
    },
  );

  it('âncora anti-vacuidade: o conjunto do kit CARREGA os papéis — o filtro acima vê alguma coisa', () => {
    const tudo = CORPOS_KIT.map(textoDoCorpo).join('\n');
    for (const id of [KIT, KIT_M1, A, A_W02, B, B_OCULTO]) expect(tudo).toContain(String(id));
    // …e um id de 10 dígitos que NÃO é papel seria pego pela mesma regex.
    expect([...'"item_id": 2500139999'.matchAll(/\d{7,}/g)].map(([d]) => d)).toEqual([
      '2500139999',
    ]);
    expect(NUMEROS_COM_PAPEL.has('2500139999')).toBe(false);
  });

  it('o README traz a tabela de PAPÉIS — cada id do corpus com o papel que ele faz', () => {
    const readme = readFileSync(join(WIRE_DIR, 'README.md'), 'utf8');
    for (const id of [KIT, KIT_M1, A, A_W02, B, B_OCULTO, RELOGIO_SONDA_KIT_1_S]) {
      expect(readme, String(id)).toContain(`\`${String(id)}\``);
    }
    expect(readme).toContain(
      `\`${String(IDS_APAGADOS_SEM_PAPEL[0])}\`–\`${String(IDS_APAGADOS_SEM_PAPEL[5])}\``,
    );
    expect(IDS_APAGADOS_SEM_PAPEL[5] - IDS_APAGADOS_SEM_PAPEL[0]).toBe(5);
    expect(readme).toContain(IMAGEM_DOC_DO_KIT);
    expect(readme).toContain(`\`${String(CATEGORIA_DOC_DO_KIT)}\``);
  });

  it.each(CORPOS_KIT)(
    '%s: nenhuma URL real e nenhum id de imagem da sonda — só o marcador e a imagem da doc',
    (file) => {
      const strings = todasAsStrings(lerFixture(file));
      const urls = strings.filter((s) => /^https?:\/\//.test(s));
      expect(urls.filter((u) => u !== 'https://example.invalid/file/redacted')).toEqual([]);
      const imagens = strings.filter((s) => /^[a-z]{2}-\d+-/.test(s));
      expect(imagens.filter((i) => i !== IMAGEM_DOC_DO_KIT)).toEqual([]);
      expect('request_id' in (lerFixture(file) as Record<string, unknown>)).toBe(false);
    },
  );

  it('PAPÉIS DISTINTOS — nenhum id faz dois papéis', () => {
    const ids = [...Object.values(IDS_DO_KIT_NO_CORPUS), ...IDS_APAGADOS_SEM_PAPEL];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('os kits nativos — a junção vale DENTRO da sonda 1 (M47)', () => {
  const lista = lerListaDeItens(FIXTURE_ITEM_LIST_SG_COM_KIT).item;
  const kit = lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO).product_info!;
  const apagados = lerListaDeItens(FIXTURE_ITEM_LIST_SG_SELLER_DELETE).item;

  it('lista, base, kit, modelos e o kit apagado falam do MESMO kit e dos MESMOS componentes', () => {
    const base = lerBaseDosItens(FIXTURE_ITEM_BASE_INFO_SG_KIT).item_list[0]!;
    const modelos = lerListaDeModelos(FIXTURE_MODEL_LIST_SG_KIT).model;
    const apagado = lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_APAGADO).product_info!;

    expect(lista.map((linha) => linha.item_id)).toEqual([KIT, A, B]);
    expect(kit.item_id).toBe(lista[0]!.item_id);
    expect(base.item_id).toBe(kit.item_id);
    expect(base.item_sku).toBe(kit.item_sku);
    expect(modelos.map((m) => m.model_id)).toEqual(kit.model_list.map((m) => m.model_id));
    expect(kit.model_list[0]!.component_list.map((c) => c.component_item_id)).toEqual([
      lista[1]!.item_id,
      lista[2]!.item_id,
    ]);
    expect(apagado.item_id).toBe(kit.item_id);
    expect(apagado.model_list).toEqual(kit.model_list);
    expect(apagados[0]!.item_id).toBe(kit.item_id);
  });

  it('QUASE-IGUAL: o oculto de B não é o modelo de A, nem o item de B, nem 0 — e o kit não é componente', () => {
    const [a, b] = kit.model_list[0]!.component_list;
    expect(b!.component_model_id).toBe(B_OCULTO);
    expect(b!.component_model_id).not.toBe(a!.component_model_id);
    expect(b!.component_model_id).not.toBe(b!.component_item_id);
    expect(b!.component_model_id).not.toBe(0);
    expect(a!.component_item_id).not.toBe(b!.component_item_id);
    expect([a!.component_item_id, b!.component_item_id]).not.toContain(kit.item_id);
  });

  it('os seis apagados SEM papel não colidem com papel nenhum', () => {
    expect(apagados.slice(1).map((linha) => linha.item_id)).toEqual([...IDS_APAGADOS_SEM_PAPEL]);
    for (const id of IDS_APAGADOS_SEM_PAPEL) {
      expect(Object.values(IDS_DO_KIT_NO_CORPUS)).not.toContain(id);
    }
  });
});

describe('os kits nativos — o que as LEITURAS da sonda 1 assentam (pelo schema do pacote)', () => {
  const kit = lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO).product_info!;

  it('get_kit_item_info: `image` e `long_image` SINGULAR, `sync_setting`, descrição `normal`, categoria ESCALAR', () => {
    expect(kit.image?.image_id_list).toEqual([IMAGEM_DOC_DO_KIT]);
    expect(kit.images).toBeNull();
    // ⚠️ M40's evidence: só `image_ratio` — nenhum `image_id_list` no singular.
    expect(kit.long_image?.image_ratio).toBe('3:4');
    expect(kit.long_image?.image_id_list).toBeNull();
    expect(kit.long_images).toBeNull();
    expect(kit.sync_setting?.auto_sync_dts).toBe(true);
    expect(kit.description_type).toBe('normal');
    expect(kit.description).toMatch(/\S/);
    expect(kit.category_id).toBe(CATEGORIA_DOC_DO_KIT);
    expect(kit.item_status).toBe('NORMAL');
    expect(kit.item_sku).toBe('SONDA-KIT');
    expect(kit.create_time).toBe(RELOGIO_SONDA_KIT_1_S);
    expect(
      kit.tier_variation_list?.map((t) => [t.name, t.option_list.map((o) => o.option)]),
    ).toEqual([['Kit', ['Kit um']]]);
  });

  it('UM principal no kit inteiro — o componente A, quantidade 2; B com 1', () => {
    const linhas = kit.model_list.flatMap((m) => m.component_list);
    expect(linhas.filter((c) => c.main_component === true).map((c) => c.component_item_id)).toEqual(
      [A],
    );
    expect(linhas.map((c) => [c.component_item_id, c.quantity, c.main_component])).toEqual([
      [A, 2, true],
      [B, 1, false],
    ]);
  });

  it('⚠️ o id OCULTO de B: NÃO-ZERO, sem nome nem SKU — e AUSENTE da lista de modelos de B', () => {
    const [a, b] = kit.model_list[0]!.component_list;
    expect(b).toMatchObject({
      component_item_id: B,
      component_model_id: B_OCULTO,
      component_model_name: '',
      component_item_or_model_sku: '',
    });
    // QUASE-IGUAL: A tem nome e SKU de modelo de verdade.
    expect(a).toMatchObject({
      component_item_id: A,
      component_model_id: A_W02,
      component_model_name: 'White,02',
      component_item_or_model_sku: 'KIT-COMP-A-M1',
    });
    const deB = lerListaDeModelos(FIXTURE_MODEL_LIST_SG_ITEM_SEM_VARIACAO);
    expect(deB.model).toEqual([]);
    expect(deB.tier_variation).toEqual([]);
    expect(textoDoCorpo(FIXTURE_MODEL_LIST_SG_ITEM_SEM_VARIACAO)).not.toContain(String(B_OCULTO));
  });

  it('o estoque do kit só se lê em get_model_list(kit) — a base do kit não o traz', () => {
    const [modelo] = lerListaDeModelos(FIXTURE_MODEL_LIST_SG_KIT).model;
    // min(⌊2 / 2⌋, ⌊6 / 1⌋) = 1 — a medição da sonda 1 no estado E0.
    expect(modelo!.stock_info_v2?.summary_info?.total_available_stock).toBe(1);
    expect(modelo!.stock_info_v2?.seller_stock).toEqual([
      { location_id: 'SGZ', stock: 1, if_saleable: true },
    ]);
    const base = lerBaseDosItens(FIXTURE_ITEM_BASE_INFO_SG_KIT).item_list[0]!;
    expect(base.has_model).toBe(true);
    expect(base.tag?.kit).toBe(true);
    expect(base.stock_info_v2).toBeNull();
    const baseCrua = lerFixture(FIXTURE_ITEM_BASE_INFO_SG_KIT) as {
      response: { item_list: Record<string, unknown>[] };
    };
    expect('stock_info_v2' in baseCrua.response.item_list[0]!).toBe(false);
  });

  it('`tag.kit` vem na LINHA de get_item_list — true no kit, false nos dois componentes', () => {
    expect(lerListaDeItens(FIXTURE_ITEM_LIST_SG_COM_KIT).item.map((l) => l.tag?.kit)).toEqual([
      true,
      false,
      false,
    ]);
    const apagados = lerListaDeItens(FIXTURE_ITEM_LIST_SG_SELLER_DELETE);
    expect(apagados.item.map((l) => l.item_status)).toEqual(Array(7).fill('SELLER_DELETE'));
    expect(apagados.item.map((l) => l.tag?.kit)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(apagados.has_next_page).toBe(false);
  });

  it('um kit APAGADO ainda é lido — SELLER_DELETE, os canais desligados', () => {
    const apagado = lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_APAGADO).product_info!;
    expect(apagado.item_status).toBe('SELLER_DELETE');
    expect(apagado.logistic_info?.map((l) => l.enabled)).toEqual([false, false]);
    // QUASE-IGUAL: o MESMO kit, vivo, tinha os dois canais ligados.
    expect(kit.logistic_info?.map((l) => l.enabled)).toEqual([true, true]);
  });

  it('um item que NÃO é kit: `"error": "."` e "product is not found" — sem `response`', () => {
    const cru = lerFixture(FIXTURE_KIT_ITEM_INFO_SG_NAO_KIT) as Record<string, unknown>;
    expect(Object.keys(cru).sort()).toEqual(['error', 'message', 'warning']);
    expect(cru.error).toBe('.');
    expect(cru.message).toMatch(/^product is not found : /);
    expect(() => lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_NAO_KIT)).toThrow();
  });

  it('get_kit_item_limit: o corpo NU do gateway — só `error`, sem `message` nem `request_id`', () => {
    expect(lerFixture(FIXTURE_KIT_ITEM_LIMIT_SG_HTTP404)).toEqual({ error: 'error_not_found' });
  });
});

/**
 * Um cliente REAL do pacote cujo `fetch` responde o TEXTO do arquivo commitado
 * com o status dado, registrando o método e o caminho de cada chamada.
 */
function clienteDoKit(
  file: string,
  status = 200,
): {
  readonly client: ShopeeClient;
  readonly chamadas: { readonly metodo: string | undefined; readonly caminho: string }[];
} {
  const texto = textoDoCorpo(file);
  const chamadas: { metodo: string | undefined; caminho: string }[] = [];
  const transporte = vi.fn<typeof globalThis.fetch>((entrada, init) => {
    const url =
      typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    chamadas.push({ metodo: init?.method, caminho: new URL(url).pathname });
    return Promise.resolve(
      new Response(texto, { status, headers: { 'content-type': 'application/json' } }),
    );
  });
  const client = createShopeeClient({
    partnerId: 1000001,
    partnerKey: 'chave-de-teste-nao-e-credencial',
    hosts: resolveShopeeHosts({ sandbox: true }),
    fetch: transporte,
    shopId: 987654,
    getAccessToken: () => Promise.resolve('access-inventado'),
  });
  return { client, chamadas };
}

describe('os kits nativos — as LEITURAS pelo CLIENTE do pacote, com o corpo commitado no fio', () => {
  it.each([
    [
      FIXTURE_ITEM_LIST_SG_COM_KIT,
      SHOPEE_GET_ITEM_LIST_PATH,
      (c: ShopeeClient): Promise<unknown> =>
        c.getItemList({ offset: 0, pageSize: 100, statuses: [SHOPEE_ITEM_STATUS_WIRE.normal] }),
      (): unknown => lerListaDeItens(FIXTURE_ITEM_LIST_SG_COM_KIT),
    ],
    [
      FIXTURE_ITEM_LIST_SG_SELLER_DELETE,
      SHOPEE_GET_ITEM_LIST_PATH,
      (c: ShopeeClient): Promise<unknown> =>
        c.getItemList({
          offset: 0,
          pageSize: 100,
          statuses: [SHOPEE_ITEM_STATUS_WIRE.sellerDelete],
        }),
      (): unknown => lerListaDeItens(FIXTURE_ITEM_LIST_SG_SELLER_DELETE),
    ],
    [
      FIXTURE_ITEM_BASE_INFO_SG_KIT,
      SHOPEE_GET_ITEM_BASE_INFO_PATH,
      (c: ShopeeClient): Promise<unknown> => c.getItemBaseInfo({ itemIds: [KIT] }),
      (): unknown => lerBaseDosItens(FIXTURE_ITEM_BASE_INFO_SG_KIT),
    ],
    [
      FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO,
      SHOPEE_GET_KIT_ITEM_INFO_PATH,
      (c: ShopeeClient): Promise<unknown> => c.getKitItemInfo({ itemId: KIT }),
      (): unknown => lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_POS_CRIACAO),
    ],
    [
      FIXTURE_KIT_ITEM_INFO_SG_APAGADO,
      SHOPEE_GET_KIT_ITEM_INFO_PATH,
      (c: ShopeeClient): Promise<unknown> => c.getKitItemInfo({ itemId: KIT }),
      (): unknown => lerKitDoCorpus(FIXTURE_KIT_ITEM_INFO_SG_APAGADO),
    ],
    [
      FIXTURE_MODEL_LIST_SG_KIT,
      SHOPEE_GET_MODEL_LIST_PATH,
      (c: ShopeeClient): Promise<unknown> => c.getModelList({ itemId: KIT }),
      (): unknown => lerListaDeModelos(FIXTURE_MODEL_LIST_SG_KIT),
    ],
    [
      FIXTURE_MODEL_LIST_SG_ITEM_SEM_VARIACAO,
      SHOPEE_GET_MODEL_LIST_PATH,
      (c: ShopeeClient): Promise<unknown> => c.getModelList({ itemId: B }),
      (): unknown => lerListaDeModelos(FIXTURE_MODEL_LIST_SG_ITEM_SEM_VARIACAO),
    ],
  ] as const)(
    '%s RESOLVE num GET, e o que o cliente devolve é o que o loader devolve',
    async (file, caminho, chamar, carregar) => {
      const { client, chamadas } = clienteDoKit(file);
      await expect(chamar(client)).resolves.toEqual(carregar());
      expect(chamadas).toEqual([{ metodo: 'GET', caminho }]);
    },
  );

  it('o item que NÃO é kit REJEITA com o `ShopeeApiError` de código "." — nunca a classe do 404', async () => {
    const promessa = clienteDoKit(FIXTURE_KIT_ITEM_INFO_SG_NAO_KIT).client.getKitItemInfo({
      itemId: A,
    });
    await expect(promessa).rejects.toBeInstanceOf(ShopeeApiError);
    await expect(promessa).rejects.not.toBeInstanceOf(ShopeeOperacaoNaoServidaError);
    await expect(promessa).rejects.toMatchObject({
      code: '.',
      providerMessage: (lerFixture(FIXTURE_KIT_ITEM_INFO_SG_NAO_KIT) as { message: string })
        .message,
    });
  });

  it('⚠️ o corpo nu servido com 404 é `ShopeeOperacaoNaoServidaError` — e o MESMO corpo com 200 é a classe BASE', async () => {
    const com404 = clienteDoKit(FIXTURE_KIT_ITEM_LIMIT_SG_HTTP404, 404).client.getKitItemLimit({
      categoryId: CATEGORIA_DOC_DO_KIT,
    });
    await expect(com404).rejects.toBeInstanceOf(ShopeeOperacaoNaoServidaError);
    await expect(com404).rejects.toMatchObject({ code: 'error_not_found', httpStatus: 404 });
    // QUASE-IGUAL: o status é a ÚNICA diferença — e é ele que o arquivo não guarda.
    const com200 = clienteDoKit(FIXTURE_KIT_ITEM_LIMIT_SG_HTTP404, 200).client.getKitItemLimit({
      categoryId: CATEGORIA_DOC_DO_KIT,
    });
    await expect(com200).rejects.toBeInstanceOf(ShopeeApiError);
    await expect(com200).rejects.not.toBeInstanceOf(ShopeeOperacaoNaoServidaError);
  });

  it('o caminho do limite de kit é o DELE — nunca o do item', async () => {
    const { client, chamadas } = clienteDoKit(FIXTURE_KIT_ITEM_LIMIT_SG_HTTP404, 404);
    await expect(client.getKitItemLimit({ categoryId: CATEGORIA_DOC_DO_KIT })).rejects.toThrow();
    expect(chamadas).toEqual([{ metodo: 'GET', caminho: SHOPEE_GET_KIT_ITEM_LIMIT_PATH }]);
  });
});

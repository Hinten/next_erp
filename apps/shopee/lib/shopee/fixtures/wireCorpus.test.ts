import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { shopeeEscrowDetailSchema } from '@delfrance/integrations-shopee';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_ESCROW_DETAIL_DOC_KIT,
  FIXTURE_ESCROW_DETAIL_QTY2_SG_PENDENTE,
  FIXTURE_ORDER_DETAIL_DOC_MASKED_VN,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  WIRE_DIR,
  lerFixture,
  lerPedidoDetalhe,
  listarFixtures,
} from './wireCorpus';

describe('o inventário do corpus', () => {
  it('é exatamente o conjunto de corpos que este passo promoveu', () => {
    // ⚠️ Conjunto EXATO, não um piso: "nunca adicione um arquivo à mão" só vale
    // se adicionar um quebrar algo. Quando o escrow do pedido de sandbox chegar,
    // este teste e a tabela do README mudam no MESMO commit — que é a revisão
    // que uma fixture nova precisa ter.
    expect(listarFixtures()).toEqual([
      FIXTURE_ESCROW_DETAIL_DOC_KIT,
      FIXTURE_ORDER_DETAIL_DOC_MASKED_VN,
      FIXTURE_ORDER_DETAIL_QTY2_SG,
    ]);
  });

  it('traz um README que separa o que a Shopee MANDOU do que a doc IMPRIME', () => {
    const readme = readFileSync(join(WIRE_DIR, 'README.md'), 'utf8');
    expect(readme).toContain(FIXTURE_ORDER_DETAIL_QTY2_SG);
    expect(readme).toContain(FIXTURE_ORDER_DETAIL_DOC_MASKED_VN);
    expect(readme).toContain(FIXTURE_ESCROW_DETAIL_DOC_KIT);
    // O slot vazio, nomeado: é o corpo que resolve o transporte do escrow e a
    // leitura por unidade vs subtotal, e nada além dele resolve.
    expect(readme).toContain(FIXTURE_ESCROW_DETAIL_QTY2_SG_PENDENTE);
    expect(readme).toContain('unverified for BR');
  });

  it('o slot do escrow do pedido de sandbox continua VAZIO — inventá-lo não responderia nada', () => {
    expect(listarFixtures()).not.toContain(FIXTURE_ESCROW_DETAIL_QTY2_SG_PENDENTE);
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

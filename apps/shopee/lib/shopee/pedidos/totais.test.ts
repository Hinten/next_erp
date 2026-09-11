/**
 * The one test that crosses the two modules — `itens.ts` + `orderMapping.ts` on
 * one side, `derivePedidoFreteTotals` (`@delfrance/schemas`) on the other.
 *
 * ⚠️ **Neither module can see this defect alone**, which is why it shipped
 * green: `itens.test.ts` proved the per-line discount is mapped, and
 * `orderMapping.test.ts` proved the header field is written; nobody added them
 * up the way the ERP does. `derivePedidoFreteTotals` is what the operator's
 * first save (`packages/data/src/pedido/usecases.ts`), the pedido footer and the
 * print all run — so the value the importer stores and the value the ERP
 * recomputes have to be the SAME number, and a test that only asks "was the
 * discount applied?" cannot say whether it was applied TWICE.
 */
import { roundReais } from '@delfrance/core/money';
import {
  STATUS_PAGAMENTO,
  derivePedidoFreteTotals,
  isPagamentoPagante,
  sumPagamentosPagos,
} from '@delfrance/schemas';
import {
  shopeeEscrowDetailPayloadSchema,
  shopeeOrderDetailRowSchema,
  type ShopeeEscrowDetail,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_ESCROW_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  lerEscrowDetalhe,
  lerPedidoDetalhe,
} from '../fixtures/wireCorpus';
import { CAPTURA_COMPRADOR_ESTADO } from './comprador';
import { mapearItensShopee } from './itens';
import { mapearFreteInicialShopee } from './orderFreteMapping';
import { mapearPedidoShopee, microsDeSegundosShopee } from './orderMapping';
import {
  ALVO_STATUS_PAGAMENTO_SHOPEE,
  esquecerLogsDePagamentoShopee,
  mapearPagamentosShopee,
  type PagamentoMapeadoShopee,
} from './pagamentoMapping';
import type { ResolvedShopeeLineProduto } from './produtoResolve';

const ORDER_SN = '260910KJBHUJDM';
const AGORA_US = 1_700_000_000_000_000;
const WATERMARK_US = microsDeSegundosShopee(1_788_973_354);
const SEM_RESOLUCAO = new Map<string, ResolvedShopeeLineProduto>();

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The whole import money path for one order, end to end: lines → freight →
 * pedido, then the ERP's own derivation over what came out.
 */
function importar(detalhe: ShopeeOrderDetailRow, escrow: ShopeeEscrowDetail | null) {
  const mapeados = mapearItensShopee({
    detalhe,
    escrow,
    resolucoes: SEM_RESOLUCAO,
    freteCobrado: null,
    nowUs: AGORA_US,
  });
  const { frete } = mapearFreteInicialShopee({ detalhe, escrow, watermarkUs: WATERMARK_US });
  const pedido = mapearPedidoShopee({
    detalhe,
    escrow,
    itens: mapeados.itens,
    conferencia: mapeados.conferencia,
    frete,
    conta: {
      integracaoPedidoOuterRef: 'documents/integracao/int-1',
      listaDePrecosOuterRef: null,
      operacaoPedidoOuterRef: null,
    },
    captura: { estado: CAPTURA_COMPRADOR_ESTADO.expirado, camposRecusados: [] },
    clientePedidoOuterRef: null,
    enderecoFiscalOuterRef: null,
    watermarkUs: WATERMARK_US,
  });
  const derivado = derivePedidoFreteTotals({
    itens: [...pedido.dados.itens],
    descontoTotal: pedido.dados.descontoTotal,
    freteInicial: pedido.dados.freteInicial,
  });
  return { mapeados, pedido, derivado };
}

/**
 * A DISCOUNTED vector, inline: quantity 2 at an escrow line total of 30 with a
 * `seller_discount` of 4, freight 4 ⇒ the buyer paid 34.
 *
 * ⚠️ It has to be inline: the SG sandbox order carries no discount at all, and a
 * discount of zero cannot distinguish "netted once" from "netted twice".
 */
function vetorComDesconto(): { detalhe: ShopeeOrderDetailRow; escrow: ShopeeEscrowDetail } {
  const detalhe = shopeeOrderDetailRowSchema.parse({
    order_sn: ORDER_SN,
    order_status: 'READY_TO_SHIP',
    region: 'BR',
    total_amount: 34,
    estimated_shipping_fee: 4,
    item_list: [
      {
        item_id: 100,
        model_id: 1,
        model_quantity_purchased: 2,
        model_discounted_price: 15,
      },
    ],
  });
  const escrow = shopeeEscrowDetailPayloadSchema.parse({
    order_sn: ORDER_SN,
    order_income: {
      buyer_total_amount: 34,
      buyer_paid_shipping_fee: 4,
      items: [
        {
          item_id: 100,
          model_id: 1,
          discounted_price: 30,
          quantity_purchased: 2,
          seller_discount: 4,
        },
      ],
    },
  });
  return { detalhe, escrow };
}

describe('⚠️ o desconto da Shopee entra UMA vez — o cruzamento dos dois módulos', () => {
  it('vetor com desconto: derivePedidoFreteTotals sobre o que o import gravou fecha em 34', () => {
    const { detalhe, escrow } = vetorComDesconto();
    const { mapeados, pedido, derivado } = importar(detalhe, escrow);

    // A linha, primeiro — o desconto ESTÁ lá, por unidade, e é o que
    // `itemSubtotal` desconta antes de somar.
    const linha = pedido.dados.itens[0]!;
    expect(linha.precoDeVenda).toBe(17);
    expect(linha.descontoUnitario).toBe(2);
    expect(linha.quantidade).toBe(2);
    expect(linha.precoDeVenda - linha.descontoUnitario!).toBe(15); // unitário LÍQUIDO
    expect(mapeados.conferencia.descontoDasLinhas).toBe(4);

    // …e o slot de ORDEM fica em zero, senão o mesmo dinheiro sai duas vezes.
    expect(pedido.dados.descontoTotal).toBe(0);
    expect(pedido.dados.freteInicial.valorCobrado).toBe(4);

    // O que o ERP recalcula = o que a Shopee diz que o comprador pagou.
    expect(derivado.valorCobrado).toBe(34);
    expect(derivado.valorCobrado).toBe(escrow.order_income!.buyer_total_amount);
    expect(derivado.valorCobrado).toBe(detalhe.total_amount);
    // …e = o que o import GRAVOU, que é a outra metade: as duas contas têm de
    // dar o mesmo número, senão o primeiro save do operador muda o pedido.
    expect(pedido.dados.valorCobrado).toBe(derivado.valorCobrado);
  });

  it('⚠️ MUTANTE: escrever descontoDasLinhas no descontoTotal do pedido dá 30, não 34', () => {
    // A mutação que este arquivo existe para matar — e ela é EXATAMENTE o código
    // que estava em produção neste PR. Nenhum teste de um módulo só a vê: a
    // linha continua com o desconto certo e o campo do pedido continua sendo
    // "a soma dos descontos".
    const { detalhe, escrow } = vetorComDesconto();
    const { mapeados, pedido } = importar(detalhe, escrow);

    const mutante = derivePedidoFreteTotals({
      itens: [...pedido.dados.itens],
      descontoTotal: mapeados.conferencia.descontoDasLinhas, // ⛔ o defeito
      freteInicial: pedido.dados.freteInicial,
    });
    expect(mutante.valorCobrado).toBe(30);
    expect(mutante.valorCobrado).not.toBe(escrow.order_income!.buyer_total_amount);
    expect(roundReais(34 - mutante.valorCobrado)).toBe(mapeados.conferencia.descontoDasLinhas);
  });

  it('pedido de sandbox SG (sem desconto): 15 × 2 + 1,99 = 31,99 pelos dois caminhos', () => {
    const detalhe = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
    const { mapeados, pedido, derivado } = importar(detalhe, null);

    expect(mapeados.conferencia.somaDosItens).toBe(30);
    expect(mapeados.conferencia.descontoDasLinhas).toBe(0);
    expect(pedido.dados.descontoTotal).toBe(0);
    expect(pedido.dados.freteInicial.valorCobrado).toBe(1.99);
    expect(derivado.valorCobrado).toBe(31.99);
    expect(derivado.valorCobrado).toBe(detalhe.total_amount);
    expect(pedido.dados.valorCobrado).toBe(derivado.valorCobrado);
  });

  it('pedido de sandbox SG com o ESCROW REAL: a primeira rampa também responde 31,99', () => {
    // ⚠️ O mesmo pedido pelos DOIS corpos que a Shopee mandou. O escrow lê o
    // preço como TOTAL DA LINHA (30 ÷ 2 = 15) e é a PRIMEIRA rampa de
    // `valorCobradoDoPedido` (`buyer_total_amount`), então este caso prova que a
    // rampa do escrow e o `total_amount` do detalhe concordam — e que trocar de
    // rampa não muda o dinheiro gravado.
    const detalhe = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
    const escrow = lerEscrowDetalhe(FIXTURE_ESCROW_DETAIL_QTY2_SG).response;
    const { mapeados, pedido, derivado } = importar(detalhe, escrow);

    expect(mapeados.diagnosticos[0]!.fontePreco).toBe('escrow');
    expect(pedido.dados.itens[0]!.precoDeVenda).toBe(15);
    expect(pedido.dados.itens[0]!.descontoUnitario).toBe(0);
    expect(pedido.dados.descontoTotal).toBe(0);
    expect(pedido.dados.freteInicial.valorCobrado).toBe(1.99);

    expect(pedido.dados.valorCobrado).toBe(escrow.order_income!.buyer_total_amount);
    expect(pedido.dados.valorCobrado).toBe(31.99);
    expect(derivado.valorCobrado).toBe(31.99);
  });
});

/* ========================================================================== */
/*  Σ pagante == valorCobrado — a identidade fiscal (#1514, passo 6, W3)       */
/* ========================================================================== */

/** As linhas que `sumPagamentosPagos` consome, a partir dos docs mapeados. */
function linhasDePagamento(
  docs: readonly PagamentoMapeadoShopee[],
): { valor: number; status_pagamento: number | null }[] {
  return docs.map((d) => ({
    valor: d.dados.valor,
    status_pagamento:
      d.sempre.alvoStatus.tipo === ALVO_STATUS_PAGAMENTO_SHOPEE.status
        ? d.sempre.alvoStatus.status
        : null,
  }));
}

/**
 * ⚠️ **Nenhum dos dois módulos vê este defeito sozinho.** `pagamentoMapping`
 * prova que `valor` é o que o mapper decidiu; `orderMapping` prova que
 * `valorCobrado` é o que a Shopee cobrou. O que a NF-e exige é que os DOIS deem
 * o mesmo número — e num marketplace `canalDevolveTroco` é FALSE, então um
 * excesso é cStat 866 e uma falta é 865: a nota simplesmente não sai.
 *
 * A costura em que a identidade pode legitimamente abrir é
 * `conferencia.diferenca` — se a soma dos itens + frete divergir do total que a
 * Shopee mandou, o `vNF` (Σ itens + frete − desconto) e o `valorCobrado`
 * (`buyer_total_amount`) deixam de ser o mesmo número, e é o passo 5 que já
 * registra essa diferença.
 */
describe('⚠️ Σ pagante == valorCobrado == derivePedidoFreteTotals — os dois módulos', () => {
  beforeEach(() => {
    esquecerLogsDePagamentoShopee();
  });

  it('pedido SG com o escrow real: um pagamento, e os TRÊS caminhos dão 31,99', () => {
    const detalhe = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
    const escrow = lerEscrowDetalhe(FIXTURE_ESCROW_DETAIL_QTY2_SG).response;
    const { pedido, derivado } = importar(detalhe, escrow);

    const { docs } = mapearPagamentosShopee({
      linha: detalhe,
      escrow,
      valorCobrado: pedido.dados.valorCobrado,
      watermarkUs: WATERMARK_US,
      nowUs: AGORA_US,
      contaId: 'int-1',
      orderSn: ORDER_SN,
    });

    expect(docs).toHaveLength(1);
    const soma = sumPagamentosPagos(linhasDePagamento(docs));
    expect(soma).toBe(31.99);
    expect(soma).toBe(pedido.dados.valorCobrado);
    expect(soma).toBe(derivado.valorCobrado);
    // ⛔ MUTANTE: ler `escrow_amount` (30,70) quebraria as três igualdades ao
    // mesmo tempo — e é a única coisa que o teste de um módulo só não vê.
    expect(soma).not.toBe(escrow.order_income!.escrow_amount);
  });

  it('pagamento combinado BR: DOIS docs, e a soma continua fechando com o pedido', () => {
    // ⚠️ Inline: o corpo SG não tem `payment_info`, e o leque de N docs é
    // exatamente onde a identidade pode quebrar sem ninguém ver — dois
    // documentos com valores plausíveis somando errado ainda parecem certos um
    // a um.
    const detalhe = shopeeOrderDetailRowSchema.parse({
      order_sn: ORDER_SN,
      order_status: 'READY_TO_SHIP',
      region: 'BR',
      pay_time: 1_788_973_353,
      total_amount: 31.99,
      estimated_shipping_fee: 1.99,
      payment_method: 'Combined Payment',
      payment_info: [
        {
          payment_method: 'pix',
          payment_amount: 10,
          card_brand: '',
          transaction_id: 'AUT-PIX',
          payment_processor_register: '11222333000181',
        },
        {
          payment_method: 'credit_card',
          payment_amount: 21.99,
          card_brand: 'visa',
          transaction_id: 'AUT-CC',
          payment_processor_register: '11222333000181',
        },
      ],
      item_list: [
        {
          item_id: 100,
          model_id: 1,
          model_quantity_purchased: 2,
          model_discounted_price: 15,
        },
      ],
    });
    const { pedido, derivado } = importar(detalhe, null);

    const { docs, diagnosticos } = mapearPagamentosShopee({
      linha: detalhe,
      escrow: null,
      valorCobrado: pedido.dados.valorCobrado,
      watermarkUs: WATERMARK_US,
      nowUs: AGORA_US,
      contaId: 'int-1',
      orderSn: ORDER_SN,
    });

    expect(diagnosticos.combinado).toBe(true);
    expect(docs).toHaveLength(2);
    expect(docs.map((d) => d.dados.valor)).toEqual([21.99, 10]);
    const soma = sumPagamentosPagos(linhasDePagamento(docs));
    expect(soma).toBe(31.99);
    expect(soma).toBe(pedido.dados.valorCobrado);
    expect(soma).toBe(derivado.valorCobrado);
  });

  it('⚠️ quem CONTA e quem não conta: em_disputa conta, em_processo e estornado não', () => {
    // A regra é `isPagamentoPagante`, e o alvo que a escada escolhe decide se a
    // perna entra na nota. `em_disputa` é uma RETENÇÃO, não uma reversão: o
    // dinheiro não se moveu, e tirá-la da soma quebraria a identidade de centavo
    // justamente nos pedidos em que um humano já está envolvido.
    const linhas = [{ valor: 31.99, status_pagamento: STATUS_PAGAMENTO.em_disputa }];
    expect(isPagamentoPagante(STATUS_PAGAMENTO.em_disputa)).toBe(true);
    expect(sumPagamentosPagos(linhas)).toBe(31.99);

    for (const status of [
      STATUS_PAGAMENTO.em_processo_aprovacao,
      STATUS_PAGAMENTO.estornado,
      STATUS_PAGAMENTO.cancelado,
    ]) {
      expect(isPagamentoPagante(status)).toBe(false);
      expect(sumPagamentosPagos([{ valor: 31.99, status_pagamento: status }])).toBe(0);
    }

    // …e `aprovado` e `null` (o legado sem status) contam, senão o negativo
    // acima não teria âncora nenhuma.
    expect(
      sumPagamentosPagos([{ valor: 31.99, status_pagamento: STATUS_PAGAMENTO.aprovado }]),
    ).toBe(31.99);
    expect(sumPagamentosPagos([{ valor: 31.99, status_pagamento: null }])).toBe(31.99);
  });
});

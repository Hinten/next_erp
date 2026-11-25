/**
 * The tests that cross the modules — `itens.ts` + `dinheiroShopee.ts` +
 * `orderMapping.ts` + `pagamentoMapping.ts` on one side, the shared totals
 * (`derivePedidoFreteTotals`, `sumPagamentosPagos`) on the other.
 *
 * ⚠️ **No single module can see these defects**, which is why they shipped
 * green before: a test that only asks "was the discount applied?" cannot say
 * whether it was applied TWICE, and a test of the pagamento mapper alone cannot
 * say whether Σ vPag still equals what the NF-e states. `derivePedidoFreteTotals`
 * is what the operator's first save (`packages/data/src/pedido/usecases.ts`), the
 * pedido footer and the print run, and the NF-e's `vNF` is the same derive with
 * the freight only under CIF (`apps/nfe/.../generator-input.ts`) — so the value
 * the importer stores, the value the ERP recomputes and the sum of the
 * pagamentos have to agree.
 */
import { roundReais } from '@delfrance/core/money';
import {
  MODALIDADE_FRETE,
  STATUS_PAGAMENTO,
  derivePedidoFreteTotals,
  isPagamentoPagante,
  sumPagamentosPagos,
  type ModalidadeFrete,
} from '@delfrance/schemas';
import {
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
import {
  VETORES_REAIS_BR,
  detalheDoVetor,
  escrowDoVetor,
  vetor,
  type VetorDinheiroShopee,
} from '../testing/vetoresDinheiro';
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
  esquecerLogsDePagamentoShopee();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * The whole import money path for one order, end to end: lines (and the money
 * model) → freight → pedido → pagamentos, then the ERP's own derivations over
 * what came out.
 */
function importar(
  detalhe: ShopeeOrderDetailRow,
  escrow: ShopeeEscrowDetail | null,
  modalidade: ModalidadeFrete = MODALIDADE_FRETE.fob,
) {
  const mapeados = mapearItensShopee({
    detalhe,
    escrow,
    resolucoes: SEM_RESOLUCAO,
    modalidade,
    nowUs: AGORA_US,
  });
  const { frete } = mapearFreteInicialShopee({
    detalhe,
    escrow,
    watermarkUs: WATERMARK_US,
    modalidade,
  });
  const pedido = mapearPedidoShopee({
    detalhe,
    itens: mapeados.itens,
    descontoTotal: mapeados.dinheiro.descontoTotal,
    dinheiroProvisorio: mapeados.dinheiro.provisorio,
    frete,
    conta: {
      integracaoPedidoOuterRef: 'documents/integracao/int-1',
      listaDePrecosOuterRef: null,
      operacaoPedidoOuterRef: null,
      modalidadeFreteImportacao: null,
    },
    captura: { estado: CAPTURA_COMPRADOR_ESTADO.expirado, camposRecusados: [] },
    clientePedidoOuterRef: null,
    enderecoFiscalOuterRef: null,
    watermarkUs: WATERMARK_US,
  });
  const pagamentos = mapearPagamentosShopee({
    linha: detalhe,
    escrow,
    valorDoComprador: mapeados.dinheiro.pagamento.valorDoComprador,
    cupomShopee: mapeados.dinheiro.pagamento.cupomShopee,
    dinheiroProvisorio: mapeados.dinheiro.provisorio,
    watermarkUs: WATERMARK_US,
    nowUs: AGORA_US,
    contaId: 'int-1',
    orderSn: detalhe.order_sn,
  });
  const derivado = derivePedidoFreteTotals({
    itens: [...pedido.dados.itens],
    descontoTotal: pedido.dados.descontoTotal,
    freteInicial: pedido.dados.freteInicial,
  });
  // The NF-e's own vNF, computed HERE from the shared derive — independent of
  // `totalDaNotaShopee`, so the invariant below is a cross-check, not a mirror.
  const cif = pedido.dados.freteInicial.modalidade === MODALIDADE_FRETE.cif;
  const vNF = derivePedidoFreteTotals({
    itens: [...pedido.dados.itens],
    descontoTotal: pedido.dados.descontoTotal,
    freteInicial: cif ? pedido.dados.freteInicial : null,
  }).valorCobrado;
  return { mapeados, pedido, pagamentos, derivado, vNF };
}

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

/* ========================================================================== */
/*  The discount enters ONCE                                                  */
/* ========================================================================== */

/**
 * A DISCOUNTED vector, inline: quantity 2 at an escrow line total of 30 with a
 * Shopee voucher of 4, freight 4 ⇒ the buyer paid 30 (`30 − 4 + 4`).
 *
 * ⚠️ It has to be inline: the SG sandbox order carries no discount at all, and a
 * discount of zero cannot distinguish "netted once" from "netted twice".
 */
function vetorComDesconto(): { detalhe: ShopeeOrderDetailRow; escrow: ShopeeEscrowDetail } {
  const v = vetor({
    quantidade: 2,
    original: 30,
    discounted: 30,
    voucherShopee: 4,
    buyerPaidShipping: 4,
    buyerTotal: 30,
    estimado: 4,
    actualDetalhe: 4,
    actualEscrow: 4,
  });
  return { detalhe: detalheDoVetor(v, { order_sn: ORDER_SN }), escrow: escrowDoVetor(v) };
}

describe('⚠️ o desconto da Shopee entra UMA vez — o cruzamento dos módulos', () => {
  it('vetor com voucher: derivePedidoFreteTotals sobre o que o import gravou fecha em 30', () => {
    const { detalhe, escrow } = vetorComDesconto();
    const { mapeados, pedido, derivado } = importar(detalhe, escrow);

    // The line first — the price is the unit `discounted_price` and the voucher
    // rides the line's discount, per unit, which `itemSubtotal` nets out.
    const linha = pedido.dados.itens[0]!;
    expect(linha.precoDeVenda).toBe(15);
    expect(linha.descontoUnitario).toBe(2);
    expect(linha.quantidade).toBe(2);
    expect(mapeados.conferencia.descontoDasLinhas).toBe(4);

    // …and the ORDER slot stays zero, or the same money leaves twice.
    expect(pedido.dados.descontoTotal).toBe(0);
    expect(pedido.dados.freteInicial.valorCobrado).toBe(4);

    // What the ERP recomputes = what Shopee says the buyer paid = what was stored.
    expect(derivado.valorCobrado).toBe(30);
    expect(derivado.valorCobrado).toBe(escrow.order_income!.buyer_total_amount);
    expect(pedido.dados.valorCobrado).toBe(derivado.valorCobrado);
  });

  it('⚠️ MUTANTE: escrever descontoDasLinhas no descontoTotal do pedido dá 26, não 30', () => {
    const { detalhe, escrow } = vetorComDesconto();
    const { mapeados, pedido } = importar(detalhe, escrow);

    const mutante = derivePedidoFreteTotals({
      itens: [...pedido.dados.itens],
      descontoTotal: mapeados.conferencia.descontoDasLinhas, // ⛔ o defeito
      freteInicial: pedido.dados.freteInicial,
    });
    expect(mutante.valorCobrado).toBe(26);
    expect(mutante.valorCobrado).not.toBe(escrow.order_income!.buyer_total_amount);
    expect(roundReais(30 - mutante.valorCobrado)).toBe(mapeados.conferencia.descontoDasLinhas);
  });

  it('pedido de sandbox SG (sem escrow): 15 × 2 + 1,99 = 31,99 no pedido, 30 na nota (FOB)', () => {
    const detalhe = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
    const { mapeados, pedido, derivado, vNF } = importar(detalhe, null);

    expect(mapeados.conferencia.somaDosItens).toBe(30);
    expect(mapeados.conferencia.descontoDasLinhas).toBe(0);
    expect(pedido.dados.descontoTotal).toBe(0);
    expect(pedido.dados.freteInicial.valorCobrado).toBe(1.99);
    expect(derivado.valorCobrado).toBe(31.99);
    expect(derivado.valorCobrado).toBe(detalhe.total_amount);
    expect(pedido.dados.valorCobrado).toBe(derivado.valorCobrado);
    expect(vNF).toBe(30);
  });

  it('pedido de sandbox SG com o ESCROW REAL: o pedido 31,99 = buyer_total_amount', () => {
    // ⚠️ O mesmo pedido pelos DOIS corpos que a Shopee mandou. O escrow lê o
    // preço como TOTAL DA LINHA (30 ÷ 2 = 15) e o resíduo fecha em zero.
    const detalhe = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
    const escrow = lerEscrowDetalhe(FIXTURE_ESCROW_DETAIL_QTY2_SG).response;
    const { mapeados, pedido, derivado } = importar(detalhe, escrow);

    expect(mapeados.diagnosticos[0]!.fontePreco).toBe('escrow');
    expect(pedido.dados.itens[0]!.precoDeVenda).toBe(15);
    expect(pedido.dados.itens[0]!.descontoUnitario).toBe(0);
    expect(pedido.dados.descontoTotal).toBe(0);
    expect(pedido.dados.freteInicial.valorCobrado).toBe(1.99);
    expect(mapeados.dinheiro.residual).toBe(0);

    expect(pedido.dados.valorCobrado).toBe(escrow.order_income!.buyer_total_amount);
    expect(pedido.dados.valorCobrado).toBe(31.99);
    expect(derivado.valorCobrado).toBe(31.99);
  });
});

/* ========================================================================== */
/*  Σ pagante == vNF — the NF-e's own identity, over every vector             */
/* ========================================================================== */

/**
 * Every vector the money model has an ESCROW arm for, with the modalidade it
 * runs under. The no-escrow arm deliberately breaks the identity — its own test
 * below says why.
 */
const TODOS: readonly {
  readonly nome: string;
  readonly v: VetorDinheiroShopee;
  readonly modalidade: ModalidadeFrete;
}[] = [
  ...VETORES_REAIS_BR.map((v) => ({ nome: v.nome, v, modalidade: MODALIDADE_FRETE.fob })),
  ...VETORES_REAIS_BR.map((v) => ({
    nome: `${v.nome} — CIF`,
    v,
    modalidade: MODALIDADE_FRETE.cif,
  })),
  {
    nome: 'piso: voucher 98 sobre 100',
    v: vetor({ voucherShopee: 98, buyerTotal: 2 }),
    modalidade: MODALIDADE_FRETE.fob,
  },
  {
    nome: 'piso, CIF com frete pago',
    v: vetor({ voucherShopee: 98, buyerPaidShipping: 3, buyerTotal: 5 }),
    modalidade: MODALIDADE_FRETE.cif,
  },
  {
    nome: 'piso, quantidade 2',
    v: vetor({ quantidade: 2, voucherShopee: 99, buyerTotal: 1 }),
    modalidade: MODALIDADE_FRETE.fob,
  },
  {
    nome: 'pix_discount não detalhado',
    v: vetor({ pixDiscount: 3, buyerTotal: 97 }),
    modalidade: MODALIDADE_FRETE.fob,
  },
  {
    nome: 'resíduo de 1 centavo',
    v: vetor({ buyerTotal: 99.99 }),
    modalidade: MODALIDADE_FRETE.fob,
  },
  {
    nome: 'pago acima das linhas',
    v: vetor({ buyerTotal: 105 }),
    modalidade: MODALIDADE_FRETE.fob,
  },
  {
    nome: 'frete pago 1,99 FOB',
    v: vetor({ original: 30, discounted: 30, buyerPaidShipping: 1.99, buyerTotal: 31.99 }),
    modalidade: MODALIDADE_FRETE.fob,
  },
  {
    nome: 'frete pago 1,99 CIF',
    v: vetor({ original: 30, discounted: 30, buyerPaidShipping: 1.99, buyerTotal: 31.99 }),
    modalidade: MODALIDADE_FRETE.cif,
  },
  {
    nome: 'arredondamento por unidade (qtd 5, voucher 6,33)',
    v: vetor({ quantidade: 5, voucherShopee: 6.33, buyerTotal: 93.67 }),
    modalidade: MODALIDADE_FRETE.fob,
  },
  {
    nome: 'piso + pago acima',
    v: vetor({ voucherShopee: 90, buyerTotal: 12 }),
    modalidade: MODALIDADE_FRETE.fob,
  },
  {
    nome: 'pago, vouchers cobrindo tudo (total 0)',
    v: vetor({ original: 15, discounted: 15, voucherShopee: 15, buyerTotal: 0, actualEscrow: 8 }),
    modalidade: MODALIDADE_FRETE.fob,
  },
];

describe('⚠️ Σ pagante == Σ itemSubtotal − descontoTotal (+ frete só sob CIF) — a identidade da NF-e', () => {
  it.each(TODOS)('$nome', ({ v, modalidade }) => {
    const { pedido, pagamentos, derivado, vNF } = importar(
      detalheDoVetor(v),
      escrowDoVetor(v),
      modalidade,
    );

    const soma = sumPagamentosPagos(linhasDePagamento(pagamentos.docs));
    expect(soma).toBe(vNF);
    // The operator's first save recomputes exactly what was stored.
    expect(pedido.dados.valorCobrado).toBe(derivado.valorCobrado);
  });

  it('⚠️ SEM escrow (pago) a identidade NÃO fecha de propósito: o pagamento ancora no total_amount', () => {
    // The lines are not net of the voucher without the escrow, so the NF-e must
    // refuse (865) rather than state 100 for what the buyer paid 90 for.
    const v = vetor({ voucherShopee: 10, buyerTotal: 90 });
    const { pedido, pagamentos, derivado, vNF } = importar(detalheDoVetor(v), null);

    expect(vNF).toBe(100);
    expect(sumPagamentosPagos(linhasDePagamento(pagamentos.docs))).toBe(90);
    expect(pagamentos.dinheiroProvisorio).toBe(true);
    expect(pedido.dados.dinheiroProvisorio).toBe(true);
    expect(pedido.dados.valorCobrado).toBe(derivado.valorCobrado);
  });

  it('⚠️ MUTANTE: manter o frete no pagamento FOB abre 865/866 na nota', () => {
    const v = vetor({ original: 30, discounted: 30, buyerPaidShipping: 1.99, buyerTotal: 31.99 });
    const { pagamentos, vNF } = importar(detalheDoVetor(v), escrowDoVetor(v));
    const mutante = roundReais(pagamentos.docs[0]!.dados.valor + 1.99);
    expect(vNF).toBe(30);
    expect(mutante).not.toBe(vNF);
  });

  it('⚠️ MUTANTE: sem o cupom, o piso deixa a nota acima do que se pagou', () => {
    const v = vetor({ voucherShopee: 98, buyerTotal: 2 });
    const { pagamentos, vNF } = importar(detalheDoVetor(v), escrowDoVetor(v));
    expect(pagamentos.docs).toHaveLength(2);
    expect(pagamentos.docs[0]!.dados.valor).toBe(2);
    expect(vNF).toBe(50);
    expect(pagamentos.docs[0]!.dados.valor).not.toBe(vNF);
  });
});

describe('⚠️ Σ pagante — os casos de pagamento', () => {
  it('pedido SG com o escrow real (FOB): um pagamento de 30 = vNF, nunca o escrow_amount', () => {
    const detalhe = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
    const escrow = lerEscrowDetalhe(FIXTURE_ESCROW_DETAIL_QTY2_SG).response;
    const { pedido, pagamentos, vNF } = importar(detalhe, escrow);

    expect(pagamentos.docs).toHaveLength(1);
    const soma = sumPagamentosPagos(linhasDePagamento(pagamentos.docs));
    expect(soma).toBe(30);
    expect(soma).toBe(vNF);
    // The pedido still carries the freight (what the web recomputes).
    expect(pedido.dados.valorCobrado).toBe(31.99);
    // ⛔ MUTANTE: ler `escrow_amount` (30,70) quebraria a igualdade.
    expect(soma).not.toBe(escrow.order_income!.escrow_amount);
  });

  /** A BR combined payment, inline — the SG body has no `payment_info`. */
  /**
   * Its escrow, order-level money only (freight paid 1,99): no escrow row pairs
   * with the line, which keeps its detail price.
   */
  function escrowCombinado(): ShopeeEscrowDetail {
    return escrowDoVetor(
      vetor({ original: 30, discounted: 30, buyerPaidShipping: 1.99, buyerTotal: 31.99 }),
    );
  }

  function detalheCombinado(): ShopeeOrderDetailRow {
    return shopeeOrderDetailRowSchema.parse({
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
  }

  it('pagamento combinado BR sob CIF: DOIS docs, e a soma continua fechando com a nota', () => {
    // ⚠️ O leque de N docs é exatamente onde a identidade pode quebrar sem
    // ninguém ver — dois documentos com valores plausíveis somando errado ainda
    // parecem certos um a um. Sob CIF a nota carrega o frete, e as pernas (que
    // somam o que o comprador pagou, frete incluído) fecham com ela.
    const { pagamentos, vNF } = importar(
      detalheCombinado(),
      escrowCombinado(),
      MODALIDADE_FRETE.cif,
    );

    expect(pagamentos.diagnosticos.combinado).toBe(true);
    expect(pagamentos.docs.map((d) => d.dados.valor)).toEqual([21.99, 10]);
    const soma = sumPagamentosPagos(linhasDePagamento(pagamentos.docs));
    expect(soma).toBe(31.99);
    expect(soma).toBe(vNF);
  });

  it('⚠️ NEAR-MISS: o mesmo combinado sob FOB COLAPSA num doc só — as pernas trazem o frete', () => {
    // The escrow answers (freight paid 1,99), so the FOB buyer leg is 30 while
    // the legs sum to 31,99.
    const { pagamentos, vNF } = importar(detalheCombinado(), escrowCombinado());

    expect(pagamentos.diagnosticos.combinado).toBe(false);
    expect(pagamentos.docs).toHaveLength(1);
    expect(sumPagamentosPagos(linhasDePagamento(pagamentos.docs))).toBe(vNF);
    expect(vNF).toBe(30);
  });

  it('⚠️ quem CONTA e quem não conta: em_disputa conta, em_processo e estornado não', () => {
    // A regra é `isPagamentoPagante`, e o alvo que a escada escolhe decide se a
    // perna entra na nota. `em_disputa` é uma RETENÇÃO, não uma reversão.
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

    expect(
      sumPagamentosPagos([{ valor: 31.99, status_pagamento: STATUS_PAGAMENTO.aprovado }]),
    ).toBe(31.99);
    expect(sumPagamentosPagos([{ valor: 31.99, status_pagamento: null }])).toBe(31.99);
  });
});

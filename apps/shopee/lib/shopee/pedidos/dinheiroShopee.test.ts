/**
 * The money model (`dinheiroShopee.ts`) over the four real BR orders' AMOUNTS
 * and the synthetic vectors that reach the arms they never do.
 *
 * The rule under test is legacy parity — Lucas's decision of 2026-11-24: the
 * NF-e states what the buyer paid, buyer-side offsets as discount, with a
 * floor. Every pair below has a NEAR-MISS beside it, so a test can say where a
 * rule stops as well as that it applies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODALIDADE_FRETE, type ItemDoPedido } from '@delfrance/schemas';

import { VETORES_REAIS_BR, detalheDoVetor, escrowDoVetor, vetor } from '../testing/vetoresDinheiro';
import {
  DESCRICAO_CUPOM_SHOPEE,
  FECHAMENTO_DINHEIRO_SHOPEE,
  FONTE_FRETE_SHOPEE,
  PISO_NFE_MINIMO_REAIS,
  descontoUnitario,
  fecharDinheiroShopee,
  freteDoPedidoShopee,
  modalidadeDoPedidoShopee,
  totalDaNotaDoPedidoArmazenado,
  totalDoCompradorShopee,
} from './dinheiroShopee';
import { mapearItensShopee } from './itens';
import { SUFIXO_CUPOM_SHOPEE, makePagamentoIdShopee } from './orderIds';
import { mapearPagamentosShopee, tarifasDeShopee } from './pagamentoMapping';
import type { ResolvedShopeeLineProduto } from './produtoResolve';

const SEM_RESOLUCAO = new Map<string, ResolvedShopeeLineProduto>();
const AGORA_US = 1_700_000_000_000_000;

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Vetor = Parameters<typeof detalheDoVetor>[0];

function mapear(
  v: Vetor,
  opcoes: {
    modalidade?: (typeof MODALIDADE_FRETE)[keyof typeof MODALIDADE_FRETE];
    semEscrow?: boolean;
    escrowOver?: Record<string, unknown>;
    detalheOver?: Record<string, unknown>;
    /** Patched onto the escrow's `order_income` (amounts only). */
    rendaOver?: Record<string, unknown>;
  } = {},
) {
  const escrow = escrowDoVetor(v, opcoes.escrowOver);
  return mapearItensShopee({
    detalhe: detalheDoVetor(v, opcoes.detalheOver),
    escrow:
      opcoes.semEscrow === true
        ? null
        : opcoes.rendaOver === undefined
          ? escrow
          : ({
              ...escrow,
              order_income: { ...escrow.order_income!, ...opcoes.rendaOver },
            } as typeof escrow),
    resolucoes: SEM_RESOLUCAO,
    modalidade: opcoes.modalidade ?? MODALIDADE_FRETE.fob,
    nowUs: AGORA_US,
  });
}

/** An UNPAID order: Shopee zero-fills `pay_time`. */
const NAO_PAGO = { pay_time: 0 };

/* ========================================================================== */
/*  The four real BR orders                                                   */
/* ========================================================================== */

describe('os quatro pedidos reais BR (só valores) — a NF-e fecha no que o comprador pagou', () => {
  it.each(VETORES_REAIS_BR)('$nome', (v) => {
    const { itens, dinheiro, conferencia } = mapear(v);

    // The line: the unit `discounted_price`, the offsets as discount.
    expect(itens).toHaveLength(1);
    expect(itens[0]!.precoDeVenda).toBe(v.discounted);
    expect(itens[0]!.descontoUnitario).toBe(v.esperado.descontoUnitario);

    // Order level: closed, nothing un-itemized, the floor not bound.
    expect(dinheiro.frete.valorCobrado).toBe(0);
    expect(dinheiro.frete.fonte).toBe(FONTE_FRETE_SHOPEE.escrow);
    expect(dinheiro.descontoTotal).toBe(0);
    expect(dinheiro.residual).toBe(0);
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.fechado);
    expect(dinheiro.piso?.aplicado).toBe(false);
    expect(dinheiro.provisorio).toBe(false);

    // The three totals agree: NF-e, pedido and the pagamento = buyer total.
    expect(dinheiro.totalDaNota).toBe(v.buyerTotal);
    expect(dinheiro.valorDoPedido).toBe(v.buyerTotal);
    expect(dinheiro.pagamento).toEqual({
      valorDoComprador: v.buyerTotal,
      cupomShopee: 0,
      divergente: false,
    });
    expect(conferencia.diferenca).toBe(0);

    // tarifas = the spread.
    const { tarifas } = tarifasDeShopee(escrowDoVetor(v));
    expect(tarifas).toBe(v.esperado.tarifas);
  });

  it('⚠️ MUTANTE: re-somar as ofertas ao preço (o defeito do port) quebra o pedido com voucher', () => {
    const v = VETORES_REAIS_BR[3]!;
    const { itens } = mapear(v);
    const mutante = itens[0]!.precoDeVenda + itens[0]!.descontoUnitario!;
    // The price would read 85.17 and the net would still be 78.84 — not 72.51.
    expect(mutante).not.toBe(v.discounted);
    expect(itens[0]!.precoDeVenda - itens[0]!.descontoUnitario!).toBeCloseTo(v.buyerTotal, 10);
  });
});

/* ========================================================================== */
/*  The per-line offsets                                                      */
/* ========================================================================== */

describe('descontoUnitario — as três ofertas do comprador, nunca os descontos do vendedor', () => {
  it('soma moedas + voucher Shopee + voucher do vendedor e divide pela quantidade do escrow', () => {
    const d = descontoUnitario(
      escrowDoVetor(
        vetor({
          quantidade: 2,
          original: 40,
          discounted: 40,
          coin: 1,
          voucherShopee: 2,
          voucherSeller: 3,
        }),
      ).order_income!.items![0]!,
    );
    expect(d).toEqual({ unitario: 3, bruto: 3, travado: false });
  });

  it('⚠️ NEAR-MISS: seller_discount / shopee_discount NÃO entram — já estão dentro do discounted_price', () => {
    const linha = escrowDoVetor(vetor({ sellerDiscount: 4 })).order_income!.items![0]!;
    expect(descontoUnitario({ ...linha, shopee_discount: 5 }).unitario).toBe(0);
  });
});

/* ========================================================================== */
/*  The floor                                                                 */
/* ========================================================================== */

describe('o piso da NF-e — max(R$ 5, 50 % do original, o custo do frete)', () => {
  it('bens 100, voucher Shopee 98 ⇒ NF 50 e um cupom de 48', () => {
    const v = vetor({ voucherShopee: 98, buyerTotal: 2, actualEscrow: 8 });
    const { itens, dinheiro } = mapear(v);

    expect(dinheiro.piso).toEqual({ valor: 50, aplicado: true, inalcancavel: false });
    expect(itens[0]!.descontoUnitario).toBe(50);
    expect(dinheiro.totalDaNota).toBe(50);
    expect(dinheiro.pagamento).toEqual({ valorDoComprador: 2, cupomShopee: 48, divergente: false });

    // …and the pagamento set: the buyer leg + the cupom leg, Σ = vNF.
    const { docs } = mapearPagamentosShopee({
      linha: detalheDoVetor(v),
      escrow: escrowDoVetor(v),
      valorDoComprador: dinheiro.pagamento.valorDoComprador,
      cupomShopee: dinheiro.pagamento.cupomShopee,
      watermarkUs: AGORA_US,
      nowUs: AGORA_US,
      contaId: 'int-1',
      orderSn: 'VETOR0000000001',
    });
    expect(docs.map((d) => d.dados.valor)).toEqual([2, 48]);
    const cupom = docs[1]!;
    expect(cupom.docId).toBe(
      makePagamentoIdShopee('int-1', 'VETOR0000000001', SUFIXO_CUPOM_SHOPEE),
    );
    expect(cupom.preencherUmaVez.id).toBe('VETOR0000000001-desconto');
    expect(cupom.dados.forma_de_pagamento).toBe(99);
    expect(cupom.dados.descricaoPagamento).toBe(DESCRICAO_CUPOM_SHOPEE);
    expect(cupom.sempre.tarifas).toBe(0);
    expect(cupom.sempre.alvoStatus).toEqual(docs[0]!.sempre.alvoStatus);
  });

  it('⚠️ NEAR-MISS: voucher 49 deixa a nota em 51 ≥ 50 — o piso não age e não há cupom', () => {
    const { itens, dinheiro } = mapear(vetor({ voucherShopee: 49, buyerTotal: 51 }));
    expect(dinheiro.piso?.aplicado).toBe(false);
    expect(itens[0]!.descontoUnitario).toBe(49);
    expect(dinheiro.totalDaNota).toBe(51);
    expect(dinheiro.pagamento.cupomShopee).toBe(0);
  });

  it('o custo do frete eleva o piso acima de 50 % do original', () => {
    const { dinheiro } = mapear(vetor({ voucherShopee: 95, buyerTotal: 5, actualEscrow: 60 }));
    expect(dinheiro.piso?.valor).toBe(60);
    expect(dinheiro.totalDaNota).toBe(60);
    expect(dinheiro.pagamento.cupomShopee).toBe(55);
  });

  it('R$ 5,00 é o mínimo absoluto', () => {
    const { dinheiro } = mapear(
      vetor({
        original: 6,
        discounted: 6,
        voucherShopee: 5.9,
        buyerTotal: 0.1,
        actualEscrow: 0,
        actualDetalhe: 0,
        estimado: 0,
      }),
    );
    expect(dinheiro.piso?.valor).toBe(PISO_NFE_MINIMO_REAIS);
    expect(dinheiro.totalDaNota).toBe(5);
  });

  it('quantidade 2: o maior resto, ao centavo, e a nota nunca fica abaixo do piso', () => {
    // Line total 100 at qty 2 (50/unit), voucher 99 (49.50/unit): floor 50.
    const { itens, dinheiro } = mapear(
      vetor({ quantidade: 2, voucherShopee: 99, buyerTotal: 1, actualEscrow: 0 }),
    );
    expect(dinheiro.piso?.aplicado).toBe(true);
    expect(itens[0]!.descontoUnitario).toBe(25);
    expect(dinheiro.totalDaNota).toBe(50);
    expect(dinheiro.pagamento.cupomShopee).toBe(49);
  });

  it('⚠️ inalcançável: linhas abaixo do piso mesmo sem desconto — a nota fica nelas, nunca acima do preço', () => {
    // original 100 but discounted 30 (seller discount 70): floor 50 > 30.
    const { itens, dinheiro } = mapear(
      vetor({
        discounted: 30,
        sellerDiscount: 70,
        voucherShopee: 20,
        buyerTotal: 10,
        actualEscrow: 0,
      }),
    );
    expect(dinheiro.piso).toEqual({ valor: 50, aplicado: true, inalcancavel: true });
    expect(itens[0]!.precoDeVenda).toBe(30);
    expect(itens[0]!.descontoUnitario).toBe(0);
    expect(dinheiro.totalDaNota).toBe(30);
    expect(dinheiro.pagamento.cupomShopee).toBe(20);
  });
});

/* ========================================================================== */
/*  The residual                                                              */
/* ========================================================================== */

describe('o resíduo — Σ líquidos + frete pago − o que o comprador pagou', () => {
  it('um pix_discount não detalhado vira descontoTotal, e a nota fecha no pago', () => {
    const { dinheiro } = mapear(vetor({ pixDiscount: 3, buyerTotal: 97 }));
    expect(dinheiro.residual).toBe(3);
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.descontoNaoDetalhado);
    expect(dinheiro.descontoTotal).toBe(3);
    expect(dinheiro.descontosDePagamento).toBe(3);
    expect(dinheiro.totalDaNota).toBe(97);
    expect(dinheiro.valorDoPedido).toBe(97);
    expect(dinheiro.pagamento.valorDoComprador).toBe(97);
  });

  it('⚠️ NEAR-MISS: um resíduo de 1 centavo FECHA — nada vira descontoTotal', () => {
    const { dinheiro } = mapear(vetor({ buyerTotal: 99.99 }));
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.fechado);
    expect(dinheiro.descontoTotal).toBe(0);
    // …and the pagamento is what the NF-e states, so Σ vPag = vNF exactly.
    expect(dinheiro.pagamento.valorDoComprador).toBe(dinheiro.totalDaNota);
  });

  it('⚠️ NEAR-MISS do lado DISTINTO: 2 centavos não detalhados já viram descontoTotal', () => {
    const { dinheiro } = mapear(vetor({ buyerTotal: 99.98 }));
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.descontoNaoDetalhado);
    expect(dinheiro.descontoTotal).toBe(0.02);
    expect(dinheiro.pagamento.valorDoComprador).toBe(99.98);
  });

  it('⚠️ NEAR-MISS do lado DISTINTO: 2 centavos pagos acima numa linha de 1 unidade já divergem', () => {
    const { dinheiro } = mapear(vetor({ buyerTotal: 100.02 }));
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.pagoAcima);
    expect(dinheiro.pagamento.divergente).toBe(true);
  });

  it('pago ACIMA das linhas ⇒ nada inventado: pagamento = total da nota, divergente', () => {
    const { dinheiro } = mapear(vetor({ buyerTotal: 105 }));
    expect(dinheiro.residual).toBe(-5);
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.pagoAcima);
    expect(dinheiro.descontoTotal).toBe(0);
    expect(dinheiro.pagamento).toEqual({ valorDoComprador: 100, cupomShopee: 0, divergente: true });
  });

  it('o arredondamento POR UNIDADE fecha: qtd 5, voucher 6,33 ⇒ linhas 93,65 contra 93,67 pagos', () => {
    // 6.33 / 5 = 1.266 → 1.27 per unit, so the lines net 18.73 × 5 = 93.65.
    const { itens, dinheiro } = mapear(
      vetor({ quantidade: 5, voucherShopee: 6.33, buyerTotal: 93.67, actualEscrow: 0 }),
    );
    expect(itens[0]!.descontoUnitario).toBe(1.27);
    expect(dinheiro.residual).toBe(-0.02);
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.fechado);
    expect(dinheiro.pagamento).toEqual({
      valorDoComprador: 93.65,
      cupomShopee: 0,
      divergente: false,
    });
  });

  it('⚠️ NEAR-MISS: qtd 5 pagando 6 centavos acima passa do limite (5) — aí sim diverge', () => {
    const { dinheiro } = mapear(vetor({ quantidade: 5, buyerTotal: 100.06, actualEscrow: 0 }));
    expect(dinheiro.residual).toBe(-0.06);
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.pagoAcima);
    expect(dinheiro.pagamento.divergente).toBe(true);
  });

  it('qtd 12 sem oferta nenhuma: 100 ÷ 12 = 8,33 ⇒ 99,96 fecha, sem incidente', () => {
    const { dinheiro } = mapear(vetor({ quantidade: 12, actualEscrow: 0 }));
    expect(dinheiro.residual).toBe(-0.04);
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.fechado);
    expect(dinheiro.pagamento.divergente).toBe(false);
  });

  it('piso + pago acima: a perna do comprador é o que ele pagou e o cupom leva o resto, sem incidente', () => {
    // Lines net 10, the buyer paid 12: `pago-acima`. Floor 50 ⇒ NF 50 = 12 + 38.
    const { dinheiro } = mapear(vetor({ voucherShopee: 90, buyerTotal: 12, actualEscrow: 0 }));
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.pagoAcima);
    expect(dinheiro.piso?.aplicado).toBe(true);
    expect(dinheiro.totalDaNota).toBe(50);
    expect(dinheiro.pagamento).toEqual({
      valorDoComprador: 12,
      cupomShopee: 38,
      divergente: false,
    });
  });

  it('piso + arredondamento: qtd 5, voucher 98,33 ⇒ comprador 1,67 + cupom 48,33', () => {
    const { dinheiro } = mapear(
      vetor({ quantidade: 5, voucherShopee: 98.33, buyerTotal: 1.67, actualEscrow: 0 }),
    );
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.fechado);
    expect(dinheiro.totalDaNota).toBe(50);
    expect(dinheiro.pagamento).toEqual({
      valorDoComprador: 1.67,
      cupomShopee: 48.33,
      divergente: false,
    });
  });
});

/* ========================================================================== */
/*  Freight and modalidade                                                    */
/* ========================================================================== */

describe('o frete pago pelo comprador e a modalidade', () => {
  const comFrete = vetor({
    original: 30,
    discounted: 30,
    buyerPaidShipping: 1.99,
    buyerTotal: 31.99,
  });

  it('FOB: a nota e o pagamento EXCLUEM o frete; o pedido o inclui', () => {
    const { dinheiro } = mapear(comFrete);
    expect(dinheiro.frete.valorCobrado).toBe(1.99);
    expect(dinheiro.totalDaNota).toBe(30);
    expect(dinheiro.pagamento.valorDoComprador).toBe(30);
    expect(dinheiro.valorDoPedido).toBe(31.99);
  });

  it('CIF: a nota (vFrete) e o pagamento INCLUEM o frete', () => {
    const { dinheiro } = mapear(comFrete, { modalidade: MODALIDADE_FRETE.cif });
    expect(dinheiro.totalDaNota).toBe(31.99);
    expect(dinheiro.pagamento.valorDoComprador).toBe(31.99);
    expect(dinheiro.valorDoPedido).toBe(31.99);
  });

  it('⚠️ um 0 do escrow é frete grátis DE VERDADE — nunca cai no estimado', () => {
    const f = freteDoPedidoShopee(detalheDoVetor(vetor({})), escrowDoVetor(vetor({})));
    expect(f).toEqual({ valorCobrado: 0, custoCalculado: 9, fonte: FONTE_FRETE_SHOPEE.escrow });
  });

  it('⚠️ NEAR-MISS: um escrow todo zerado (pedido não pago) nunca grava 0 — cai no estimado', () => {
    const v = vetor({ buyerTotal: 0, escrowAmount: 0, estimado: 9.62 });
    expect(totalDoCompradorShopee(detalheDoVetor(v, NAO_PAGO), escrowDoVetor(v))).toBeNull();
    const { dinheiro } = mapear(v, { detalheOver: NAO_PAGO });
    expect(dinheiro.frete).toMatchObject({
      valorCobrado: 9.62,
      fonte: FONTE_FRETE_SHOPEE.estimado,
    });
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.semEscrow);
    expect(dinheiro.piso).toBeNull();
    // Unpaid: nothing provisional to protect — the next delivery re-maps it all.
    expect(dinheiro.provisorio).toBe(false);
  });

  it('um pedido PAGO que os vouchers cobrem inteiro (total 0) chega ao piso: NF 8, comprador 0 + cupom 8', () => {
    // Line 15, Shopee voucher 15, free shipping, the shipment costs 8.
    const v = vetor({
      original: 15,
      discounted: 15,
      voucherShopee: 15,
      buyerTotal: 0,
      escrowAmount: 0,
      actualEscrow: 8,
    });
    expect(totalDoCompradorShopee(detalheDoVetor(v), escrowDoVetor(v))).toBe(0);
    const { dinheiro } = mapear(v);
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.fechado);
    expect(dinheiro.frete).toMatchObject({ valorCobrado: 0, fonte: FONTE_FRETE_SHOPEE.escrow });
    expect(dinheiro.piso).toEqual({ valor: 8, aplicado: true, inalcancavel: false });
    expect(dinheiro.totalDaNota).toBe(8);
    expect(dinheiro.valorDoPedido).toBe(8);
    expect(dinheiro.pagamento).toEqual({ valorDoComprador: 0, cupomShopee: 8, divergente: false });
  });

  it('⚠️ NEAR-MISS: o mesmo pedido com 1 centavo pago dá a MESMA nota — 0,01 + cupom 7,99', () => {
    const v = vetor({
      original: 15,
      discounted: 15,
      voucherShopee: 14.99,
      buyerTotal: 0.01,
      escrowAmount: 0,
      actualEscrow: 8,
    });
    const { dinheiro } = mapear(v);
    expect(dinheiro.totalDaNota).toBe(8);
    expect(dinheiro.pagamento).toEqual({
      valorDoComprador: 0.01,
      cupomShopee: 7.99,
      divergente: false,
    });
  });

  it('⚠️ um escrow SEM buyer_paid_shipping_fee não responde: o estimado nunca vira descontoTotal', () => {
    const { dinheiro } = mapear(vetor({}), { rendaOver: { buyer_paid_shipping_fee: null } });
    expect(dinheiro.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.semEscrow);
    expect(dinheiro.descontoTotal).toBe(0);
    expect(dinheiro.frete).toMatchObject({ valorCobrado: 9, fonte: FONTE_FRETE_SHOPEE.estimado });
    expect(dinheiro.totalDaNota).toBe(100);
    // …and the pagamento anchors on the order's `total_amount`, which here agrees.
    expect(dinheiro.pagamento.valorDoComprador).toBe(100);
  });

  it('sem escrow: o estimado, nenhum resíduo, nenhum piso — e o pagamento ANCORA no total_amount', () => {
    // The detail's `total_amount` is what the buyer paid (2); the lines are not
    // net of the voucher (100). Σ vPag ≠ vNF ⇒ the NF-e refuses (865) instead of
    // stating a pre-voucher value.
    const { dinheiro } = mapear(vetor({ voucherShopee: 98, buyerTotal: 2 }), { semEscrow: true });
    expect(dinheiro.frete).toMatchObject({ valorCobrado: 9, fonte: FONTE_FRETE_SHOPEE.estimado });
    expect(dinheiro.residual).toBeNull();
    expect(dinheiro.piso).toBeNull();
    expect(dinheiro.totalDaNota).toBe(100);
    expect(dinheiro.pagamento).toEqual({
      valorDoComprador: 2,
      cupomShopee: 0,
      divergente: false,
    });
    expect(dinheiro.pagamento.valorDoComprador).not.toBe(dinheiro.totalDaNota);
    // Paid ⇒ provisional: an update keeps the stored money.
    expect(dinheiro.provisorio).toBe(true);
  });

  it('⚠️ NEAR-MISS: sem escrow e sem total_amount, a âncora é o total do pedido (linhas + frete)', () => {
    const { dinheiro } = mapear(vetor({}), { semEscrow: true, detalheOver: { total_amount: 0 } });
    expect(dinheiro.valorDoPedido).toBe(109);
    expect(dinheiro.pagamento.valorDoComprador).toBe(109);
  });

  it('o custo: actual do escrow (>0) ?? actual do detalhe ?? estimado — o zero do detalhe é ausência', () => {
    const v = vetor({ actualDetalhe: 0, actualEscrow: 0, estimado: 7 });
    expect(freteDoPedidoShopee(detalheDoVetor(v), escrowDoVetor(v)).custoCalculado).toBe(7);
  });
});

describe('modalidadeDoPedidoShopee', () => {
  it('o bloco gravado vence, depois a conta, depois FOB', () => {
    const gravado = { freteInicial: { modalidade: MODALIDADE_FRETE.cif } };
    expect(modalidadeDoPedidoShopee(gravado, MODALIDADE_FRETE.fob)).toBe(MODALIDADE_FRETE.cif);
    expect(modalidadeDoPedidoShopee(null, MODALIDADE_FRETE.cif)).toBe(MODALIDADE_FRETE.cif);
    expect(modalidadeDoPedidoShopee(null, null)).toBe(MODALIDADE_FRETE.fob);
  });

  it('⚠️ NEAR-MISS: uma modalidade gravada ilegível não vence a da conta', () => {
    expect(
      modalidadeDoPedidoShopee({ freteInicial: { modalidade: '7' } }, MODALIDADE_FRETE.cif),
    ).toBe(MODALIDADE_FRETE.cif);
  });
});

/* ========================================================================== */
/*  The stored-pedido reader                                                  */
/* ========================================================================== */

function linhaGravada(over: Partial<ItemDoPedido> = {}): Record<string, unknown> {
  return {
    produtoUid: null,
    ordem: 0,
    ensureUniqueId: 'e-0',
    mktplaceId: '1',
    sku: null,
    gtin: null,
    nomeDeVenda: null,
    precoDeVenda: 53.87,
    descontoUnitario: 2.64,
    quantidade: 1,
    custo: null,
    timestamp: null,
    imposto: null,
    dfeReferenciado: null,
    ajusteRtc: null,
    ...over,
  };
}

describe('totalDaNotaDoPedidoArmazenado — o vNF de um pedido GRAVADO', () => {
  it('linhas − descontoTotal, frete só sob CIF', () => {
    const fob = {
      itens: { NONE: [linhaGravada()] },
      descontoTotal: 0,
      freteInicial: { modalidade: MODALIDADE_FRETE.fob, valorCobrado: 4 },
    };
    expect(totalDaNotaDoPedidoArmazenado(fob).totalDaNota).toBe(51.23);
    const cif = { ...fob, freteInicial: { modalidade: MODALIDADE_FRETE.cif, valorCobrado: 4 } };
    expect(totalDaNotaDoPedidoArmazenado(cif).totalDaNota).toBe(55.23);
  });

  it('⚠️ NEAR-MISS: uma linha ilegível dá null, nunca uma soma parcial', () => {
    const doc = { itens: { NONE: [linhaGravada(), { precoDeVenda: 'dez' }] } };
    expect(totalDaNotaDoPedidoArmazenado(doc)).toEqual({ totalDaNota: null, linhasIlegiveis: 1 });
  });
});

describe('fecharDinheiroShopee — um desconto de linha nunca passa do preço', () => {
  it('a linha nunca fica negativa (e o piso então leva a nota a R$ 5)', () => {
    const v = vetor({
      original: 10,
      discounted: 10,
      voucherShopee: 12,
      buyerTotal: 0.01,
      actualEscrow: 0,
      actualDetalhe: 0,
      estimado: 0,
    });
    const d = fecharDinheiroShopee({
      itens: mapear(v).itens.map((i) => ({ ...i, descontoUnitario: 12 })),
      originais: [10],
      detalhe: detalheDoVetor(v),
      escrow: escrowDoVetor(v),
      modalidade: MODALIDADE_FRETE.fob,
    });
    expect(d.itens[0]!.descontoUnitario).toBeLessThanOrEqual(d.itens[0]!.precoDeVenda);
    expect(d.totalDaNota).toBe(5);
    // ⚠️ The floor alone would bring an UNCAPPED line back to 5 too; what only
    // the cap gives is the residual (0 − 0.01, not −2.01) and so the arm.
    expect(d.residual).toBe(-0.01);
    expect(d.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.fechado);
    expect(d.pagamento).toEqual({ valorDoComprador: 0.01, cupomShopee: 4.99, divergente: false });
  });

  it('duas linhas, piso fora: o excesso do voucher da linha A vai para o descontoTotal, nunca para uma linha negativa', () => {
    // A: price 10 with a voucher of 12; B: price 100, nothing. The buyer paid 98.
    const v = vetor({ buyerTotal: 98, actualEscrow: 0, actualDetalhe: 0, estimado: 0 });
    const modelo = mapear(v).itens[0]!;
    const d = fecharDinheiroShopee({
      itens: [
        { ...modelo, ordem: 0, precoDeVenda: 10, descontoUnitario: 12 },
        { ...modelo, ordem: 1, ensureUniqueId: 'e-1', precoDeVenda: 100, descontoUnitario: 0 },
      ],
      originais: [10, 100],
      detalhe: detalheDoVetor(v),
      escrow: escrowDoVetor(v),
      modalidade: MODALIDADE_FRETE.fob,
    });
    expect(d.piso?.aplicado).toBe(false);
    expect(d.itens[0]!.descontoUnitario).toBe(10);
    expect(d.descontoTotal).toBe(2);
    expect(d.fechamento).toBe(FECHAMENTO_DINHEIRO_SHOPEE.descontoNaoDetalhado);
    expect(d.totalDaNota).toBe(98);
  });
});

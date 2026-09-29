import { describe, expect, it } from 'vitest';
import { roundReais } from '@delfrance/core/money';
import { FORMA_PAGAMENTO, STATUS_PAGAMENTO, sumPagamentosPagos } from '../collection/pagamento';
import {
  coberturaDoPedido,
  valorDevolvido,
  type PagamentoCoberturaRow,
  type PedidoCoberturaInput,
} from './cobertura';

function linha(precoDeVenda: number, descontoUnitario: number, quantidade: number) {
  return { precoDeVenda, descontoUnitario, quantidade };
}

/** A pagamento row — an approved pix unless overridden. */
function pagamento(
  valor: number,
  opcoes: Partial<PagamentoCoberturaRow> = {},
): PagamentoCoberturaRow {
  return {
    valor,
    status_pagamento: STATUS_PAGAMENTO.aprovado,
    forma_de_pagamento: FORMA_PAGAMENTO.pix,
    ...opcoes,
  };
}

/** A crédito-loja pagamento — the way an operator registers the returned value for the NF-e. */
function creditoLoja(valor: number, opcoes: Partial<PagamentoCoberturaRow> = {}) {
  return pagamento(valor, { forma_de_pagamento: FORMA_PAGAMENTO.credito_loja, ...opcoes });
}

/** A saída returning ONE line worth `valor`. */
function devolvendo(valor: number) {
  return { orig1: { p1: [linha(valor, 0, 1)] } };
}

function troca(
  valorCobrado: number,
  itensDevolvidos: unknown,
  extra: Partial<PedidoCoberturaInput> = {},
): PedidoCoberturaInput {
  return { valorCobrado, itensDevolvidos, ...extra };
}

/** (10 − 1) × 2 in an origin bucket + 5 × 1 in the 'NONE' bucket = 23. */
const DEVOLVIDOS_23 = { o1: { p1: [linha(10, 1, 2)] }, NONE: { p2: [linha(5, 0, 1)] } };

describe('valorDevolvido', () => {
  it('sums (preço − desconto) × quantidade across origins AND the NONE bucket', () => {
    expect(valorDevolvido({ itensDevolvidos: DEVOLVIDOS_23 })).toBe(23);
    // dropping the NONE bucket would read 18 — the assertion above is what kills that
    expect(valorDevolvido({ itensDevolvidos: { o1: DEVOLVIDOS_23.o1 } })).toBe(18);
    // several lines in ONE list, and several produtos in one origin
    expect(
      valorDevolvido({
        itensDevolvidos: { o1: { p1: [linha(10, 1, 2), linha(3, 0, 1)], p2: [linha(1, 0, 1)] } },
      }),
    ).toBe(22);
  });

  it('is not influenced by the total charged (descontoTotal / frete never enter)', () => {
    expect(coberturaDoPedido(troca(37, DEVOLVIDOS_23), []).valorDevolvido).toBe(23);
    expect(coberturaDoPedido(troca(1, DEVOLVIDOS_23), []).valorDevolvido).toBe(23);
  });

  it('NEAR-MISS: an entrada (ehSaida === false) has no devolução credit', () => {
    expect(valorDevolvido({ ehSaida: false, itensDevolvidos: DEVOLVIDOS_23 })).toBe(0);
    expect(valorDevolvido({ ehSaida: true, itensDevolvidos: DEVOLVIDOS_23 })).toBe(23);
  });

  it('counts a null / absent ehSaida as saída (only an explicit false is an entrada)', () => {
    expect(valorDevolvido({ ehSaida: null, itensDevolvidos: DEVOLVIDOS_23 })).toBe(23);
    expect(valorDevolvido({ itensDevolvidos: DEVOLVIDOS_23 })).toBe(23);
  });

  it('rounds the raw SUM once, not each line', () => {
    // 0.4 × 1.01 = 0.404 twice: raw 0.808 → 0.81; rounding per line would read 0.40 + 0.40
    const duasLinhas = { o1: { p1: [linha(1.01, 0, 0.4), linha(1.01, 0, 0.4)] } };
    expect(valorDevolvido({ itensDevolvidos: duasLinhas })).toBe(0.81);
    // half a cent up: 0.5 × 1.01 = 0.505 → 0.51
    const meioCentavo = { o1: { p1: [linha(1.01, 0, 0.5)] } };
    expect(valorDevolvido({ itensDevolvidos: meioCentavo })).toBe(0.51);
  });

  it('reads nothing from an absent / empty devolução', () => {
    for (const vazio of [null, undefined, {}, { o1: {} }, { o1: { p1: [] } }]) {
      expect(valorDevolvido({ itensDevolvidos: vazio })).toBe(0);
    }
  });
});

describe('coberturaDoPedido — the devolução credit', () => {
  it('counts the returned value as paid against the GROSS total (nothing else paid yet)', () => {
    const c = coberturaDoPedido(troca(100, DEVOLVIDOS_23), []);
    expect(c).toEqual({
      valorCobrado: 100,
      valorDevolvido: 23,
      creditoLojaPago: 0,
      creditoDevolucao: 23,
      valorPago: 0,
      valorQuitado: 23,
      saldo: 77,
      restante: 77,
      troco: 0,
    });
  });

  it('an even swap is fully covered by the credit alone', () => {
    const c = coberturaDoPedido(troca(150, devolvendo(150)), []);
    expect(c.valorQuitado).toBe(150);
    expect(c.restante).toBe(0);
    expect(c.troco).toBe(0);
  });

  it('NEAR-MISS: an entrada with the same items and payments is NOT credited', () => {
    const saida = coberturaDoPedido(troca(150, devolvendo(100)), [pagamento(50)]);
    const entrada = coberturaDoPedido(troca(150, devolvendo(100), { ehSaida: false }), [
      pagamento(50),
    ]);
    expect(saida.valorQuitado).toBe(150);
    expect(saida.restante).toBe(0);
    expect(entrada.creditoDevolucao).toBe(0);
    expect(entrada.valorQuitado).toBe(50);
    expect(entrada.valorQuitado).toBe(entrada.valorPago);
    expect(entrada.restante).toBe(100);
  });

  it('treats a null / absent ehSaida as saída', () => {
    expect(coberturaDoPedido(troca(100, devolvendo(40), { ehSaida: null }), []).restante).toBe(60);
    expect(coberturaDoPedido(troca(100, devolvendo(40)), []).restante).toBe(60);
  });

  it('without a devolução it is exactly the payments (valorQuitado === sumPagamentosPagos)', () => {
    const { pix, dinheiro, cartao_credito } = FORMA_PAGAMENTO;
    const { aprovado, em_disputa, recusado, pendente } = STATUS_PAGAMENTO;
    const linhas = [
      { valor: 40, status_pagamento: aprovado, forma_de_pagamento: pix },
      { valor: 10, status_pagamento: null, forma_de_pagamento: dinheiro },
      { valor: 5, status_pagamento: em_disputa, forma_de_pagamento: cartao_credito },
      { valor: 99, status_pagamento: recusado, forma_de_pagamento: pix },
      { valor: 7, status_pagamento: pendente, forma_de_pagamento: pix },
    ];
    for (const vazio of [null, undefined, {}, { o1: { p1: [] } }]) {
      const c = coberturaDoPedido(troca(100, vazio), linhas);
      expect(c.creditoDevolucao).toBe(0);
      expect(c.valorPago).toBe(sumPagamentosPagos(linhas));
      expect(c.valorQuitado).toBe(sumPagamentosPagos(linhas));
      expect(c.saldo).toBe(100);
      expect(c.restante).toBe(45);
    }
  });

  it('rounds the credit BEFORE the payments are added (OD3): paying the shown restante closes it', () => {
    // 0.5 × R$ 1,01 = 0.505 raw; the footer shows Devoluções R$ 0,51
    const p = troca(17.35, { o: { p: [linha(1.01, 0, 0.5)] } });
    const antes = coberturaDoPedido(p, []);
    expect(antes.creditoDevolucao).toBe(0.51);
    expect(antes.restante).toBe(16.84);
    // a raw-credit sum would read roundReais(0.505 + 16.84) = 17.34, one cent short
    const depois = coberturaDoPedido(p, [pagamento(16.84)]);
    expect(depois.valorQuitado).toBe(17.35);
    expect(depois.restante).toBe(0);
  });

  it('pins the deliberate deviation from legacy on a half-cent edge', () => {
    // 1.03 × 1.5 = 1.545 (double 1.5449…) → credit 1.54. Legacy summed the raw 1.545 with a
    // payment of 20 and rounded once (21.55); the rounded credit reads 21.54.
    const c = coberturaDoPedido(troca(50, { o: { p: [linha(1.03, 0, 1.5)] } }), [pagamento(20)]);
    expect(c.creditoDevolucao).toBe(1.54);
    expect(c.valorQuitado).toBe(21.54);
  });

  it('a credit above the total gives a NET-negative saldo, nothing left to pay and a troco', () => {
    const c = coberturaDoPedido(troca(100, devolvendo(120)), []);
    expect(c.saldo).toBe(-20);
    expect(c.restante).toBe(0);
    expect(c.troco).toBe(20);
    expect(c.valorQuitado).toBe(120);
  });

  it('NEAR-MISS: a credit of exactly the total has no troco; one cent less leaves one cent', () => {
    const exato = coberturaDoPedido(troca(100, devolvendo(100)), []);
    expect(exato.restante).toBe(0);
    expect(exato.troco).toBe(0);
    expect(exato.saldo).toBe(0);
    const curto = coberturaDoPedido(troca(100, devolvendo(99.99)), []);
    expect(curto.restante).toBe(0.01);
    expect(curto.troco).toBe(0);
  });

  it('credit 100 + payment 49.99 on 150 leaves R$ 0,01', () => {
    const c = coberturaDoPedido(troca(150, devolvendo(100)), [pagamento(49.99)]);
    expect(c.valorQuitado).toBe(149.99);
    expect(c.restante).toBe(0.01);
    expect(c.troco).toBe(0);
    // ... and 50 closes it
    expect(coberturaDoPedido(troca(150, devolvendo(100)), [pagamento(50)]).restante).toBe(0);
  });

  it('a payment beyond the remainder shows up as troco', () => {
    const c = coberturaDoPedido(troca(150, devolvendo(100)), [pagamento(60)]);
    expect(c.valorPago).toBe(60);
    expect(c.restante).toBe(0);
    expect(c.troco).toBe(10);
    // legacy footer: Troco = Vlr. Pago − NET Total
    expect(c.troco).toBe(roundReais(c.valorPago - c.saldo));
  });

  it('keeps the legacy footer identity troco = valorPago − saldo when nothing is crédito loja', () => {
    for (const [total, devolvido, pago] of [
      [150, 100, 60],
      [100, 120, 0],
      [80, 0, 100],
      [80, 30, 50],
      [80, 30, 49.99],
    ] as const) {
      const c = coberturaDoPedido(
        troca(total, devolvido > 0 ? devolvendo(devolvido) : null),
        pago > 0 ? [pagamento(pago)] : [],
      );
      expect(c.troco).toBe(Math.max(0, roundReais(c.valorPago - c.saldo)));
    }
  });
});

describe('coberturaDoPedido — payments filter', () => {
  it('counts null and em_disputa payments, like sumPagamentosPagos', () => {
    const c = coberturaDoPedido(troca(100, null), [
      pagamento(10),
      pagamento(20, { status_pagamento: null }),
      pagamento(30, { status_pagamento: STATUS_PAGAMENTO.em_disputa }),
    ]);
    expect(c.valorPago).toBe(60);
    expect(c.restante).toBe(40);
  });

  it('does not count pendente / recusado / cancelado / estornado payments', () => {
    const c = coberturaDoPedido(troca(100, null), [
      pagamento(10),
      pagamento(1000, { status_pagamento: STATUS_PAGAMENTO.pendente }),
      pagamento(1000, { status_pagamento: STATUS_PAGAMENTO.recusado }),
      pagamento(1000, { status_pagamento: STATUS_PAGAMENTO.cancelado }),
      pagamento(1000, { status_pagamento: STATUS_PAGAMENTO.estornado }),
    ]);
    expect(c.valorPago).toBe(10);
    expect(c.restante).toBe(90);
  });

  it('reads a non-finite / missing valor as 0 and never returns NaN', () => {
    const c = coberturaDoPedido(troca(100, devolvendo(30)), [
      pagamento(Number.NaN),
      pagamento(Number.POSITIVE_INFINITY),
      { status_pagamento: STATUS_PAGAMENTO.aprovado },
      pagamento(0, { valor: null }),
      pagamento(20),
    ]);
    expect(c.valorPago).toBe(20);
    expect(c.valorQuitado).toBe(50);
    for (const n of Object.values(c)) expect(Number.isNaN(n)).toBe(false);
  });

  it('reads a null / undefined / non-finite valorCobrado as 0', () => {
    for (const total of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = coberturaDoPedido({ valorCobrado: total, itensDevolvidos: devolvendo(10) }, []);
      expect(c.valorCobrado).toBe(0);
      expect(c.restante).toBe(0);
      expect(c.troco).toBe(10);
    }
  });
});

describe('coberturaDoPedido — crédito loja is not counted twice (OD1)', () => {
  it('a crédito loja registered for the returned value REPLACES the credit', () => {
    // returns 100 + crédito loja 100 (for the NF-e) + pix 50 on a 150 total
    const c = coberturaDoPedido(troca(150, devolvendo(100)), [creditoLoja(100), pagamento(50)]);
    expect(c.creditoLojaPago).toBe(100);
    expect(c.creditoDevolucao).toBe(0);
    expect(c.valorPago).toBe(150);
    // counted twice this would read 250 with a troco of 100
    expect(c.valorQuitado).toBe(150);
    expect(c.restante).toBe(0);
    expect(c.troco).toBe(0);
  });

  it('NEAR-MISS: the difference not yet paid keeps the pedido open', () => {
    const c = coberturaDoPedido(troca(150, devolvendo(100)), [creditoLoja(100), pagamento(49.99)]);
    expect(c.valorQuitado).toBe(149.99);
    expect(c.restante).toBe(0.01);
  });

  it('NEAR-MISS: a RECUSADO crédito loja does not reduce the credit', () => {
    const c = coberturaDoPedido(troca(150, devolvendo(100)), [
      creditoLoja(100, { status_pagamento: STATUS_PAGAMENTO.recusado }),
      pagamento(50),
    ]);
    expect(c.creditoLojaPago).toBe(0);
    expect(c.creditoDevolucao).toBe(100);
    expect(c.valorPago).toBe(50);
    expect(c.valorQuitado).toBe(150);
  });

  it('NEAR-MISS: only the crédito loja FORMA reduces the credit (a pix of the same value does not)', () => {
    const c = coberturaDoPedido(troca(200, devolvendo(100)), [pagamento(100)]);
    expect(c.creditoLojaPago).toBe(0);
    expect(c.creditoDevolucao).toBe(100);
    expect(c.valorQuitado).toBe(200);
    expect(c.restante).toBe(0);
  });

  it('a partial crédito loja leaves the rest of the returned value as credit', () => {
    const c = coberturaDoPedido(troca(150, devolvendo(100)), [creditoLoja(40)]);
    expect(c.creditoDevolucao).toBe(60);
    expect(c.valorPago).toBe(40);
    expect(c.valorQuitado).toBe(100);
    expect(c.restante).toBe(50);
  });

  it('never goes negative: a crédito loja above the returned value leaves credit 0', () => {
    const c = coberturaDoPedido(troca(150, devolvendo(100)), [creditoLoja(130)]);
    expect(c.creditoDevolucao).toBe(0);
    expect(c.valorQuitado).toBe(130);
    expect(c.restante).toBe(20);
  });

  it('counts a crédito loja with a null / em_disputa status as paying, like any pagamento', () => {
    const nulo = coberturaDoPedido(troca(150, devolvendo(100)), [
      creditoLoja(100, { status_pagamento: null }),
    ]);
    expect(nulo.creditoLojaPago).toBe(100);
    expect(nulo.creditoDevolucao).toBe(0);
    const disputa = coberturaDoPedido(troca(150, devolvendo(100)), [
      creditoLoja(100, { status_pagamento: STATUS_PAGAMENTO.em_disputa }),
    ]);
    expect(disputa.creditoLojaPago).toBe(100);
  });

  it('a crédito loja on a pedido WITHOUT a devolução is just a payment', () => {
    const c = coberturaDoPedido(troca(150, null), [creditoLoja(100)]);
    expect(c.creditoDevolucao).toBe(0);
    expect(c.valorQuitado).toBe(100);
    expect(c.restante).toBe(50);
  });
});

describe('coberturaDoPedido — raw snapshot tolerance', () => {
  /** A raw snapshot with ONE bucket holding `itens` (whatever shape they have). */
  const cru = (...itens: unknown[]) => ({ o: { p: itens } });

  it('counts a string price / discount / quantity as 0 (fail-safe, not coerced)', () => {
    const valido = linha(10, 0, 1);
    // '10' would coerce to 10 under a bare `-` / `*`; here it is 0
    const precoTexto = { precoDeVenda: '10', descontoUnitario: 0, quantidade: 2 };
    expect(valorDevolvido({ itensDevolvidos: cru(precoTexto, valido) })).toBe(10);
    // a string discount counts as 0, so the price is NOT reduced by it
    const descontoTexto = { precoDeVenda: 10, descontoUnitario: '3', quantidade: 2 };
    expect(valorDevolvido({ itensDevolvidos: cru(descontoTexto) })).toBe(20);
    const quantidadeTexto = { precoDeVenda: 10, descontoUnitario: 0, quantidade: '2' };
    expect(valorDevolvido({ itensDevolvidos: cru(quantidadeTexto, valido) })).toBe(10);
  });

  it('counts a missing quantidade as 0 and a null discount as 0', () => {
    const semQuantidade = { precoDeVenda: 10, descontoUnitario: 1 };
    expect(valorDevolvido({ itensDevolvidos: cru(semQuantidade) })).toBe(0);
    const descontoNulo = { precoDeVenda: 10, descontoUnitario: null, quantidade: 2 };
    expect(valorDevolvido({ itensDevolvidos: cru(descontoNulo) })).toBe(20);
  });

  it('counts a NaN / Infinity field as 0', () => {
    const precoInfinito = { precoDeVenda: Infinity, descontoUnitario: 0, quantidade: 1 };
    const quantidadeNaN = { precoDeVenda: 10, descontoUnitario: 0, quantidade: Number.NaN };
    const itensDevolvidos = cru(precoInfinito, quantidadeNaN, linha(4, 0, 1));
    expect(valorDevolvido({ itensDevolvidos })).toBe(4);
  });

  it('skips a non-object bucket, a non-array list and a non-object item without throwing', () => {
    const bagunca = {
      o1: 5,
      o2: { p1: 'texto', p2: [linha(10, 0, 1), null, 3, 'x', [linha(99, 0, 1)]], p3: null },
      o3: null,
      o4: [linha(99, 0, 1)],
      NONE: { p4: { 0: linha(99, 0, 1) } },
    };
    expect(valorDevolvido({ itensDevolvidos: bagunca })).toBe(10);
  });

  it('reads nothing from a devolução that is not a map at all', () => {
    for (const lixo of ['texto', 5, true, [], [linha(10, 0, 1)]]) {
      expect(valorDevolvido({ itensDevolvidos: lixo })).toBe(0);
    }
  });
});

describe('coberturaDoPedido — paying the shown restante always closes the pedido', () => {
  const PRECOS = [1.01, 1.03, 1.05, 2.675, 0.99, 3.335, 10.005];
  const QUANTIDADES = [0.5, 1.5, 2.5, 0.333, 1.25, 0.125];
  const TOTAIS = [17.35, 100, 50.01, 9.99, 3.2];
  const JA_PAGO = [0, 3.33];

  it('valorQuitado >= valorCobrado after paying restante; one cent less does not', () => {
    let verificados = 0;
    for (const preco of PRECOS) {
      for (const quantidade of QUANTIDADES) {
        for (const total of TOTAIS) {
          for (const jaPago of JA_PAGO) {
            const p = troca(total, { o: { p: [linha(preco, 0, quantidade)] } });
            const restante = coberturaDoPedido(p, [pagamento(jaPago)]).restante;
            if (restante === 0) continue;
            verificados += 1;

            const pago = coberturaDoPedido(p, [pagamento(jaPago), pagamento(restante)]);
            expect(pago.valorQuitado).toBeGreaterThanOrEqual(pago.valorCobrado);
            expect(pago.restante).toBe(0);

            const curto = coberturaDoPedido(p, [
              pagamento(jaPago),
              pagamento(roundReais(restante - 0.01)),
            ]);
            expect(curto.valorQuitado).toBeLessThan(curto.valorCobrado);
            expect(curto.restante).toBe(0.01);
          }
        }
      }
    }
    // the sweep must not be vacuous
    expect(verificados).toBeGreaterThan(300);
  });
});
